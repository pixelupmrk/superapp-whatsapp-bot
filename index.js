const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, // AINDA USAMOS PARA TESTE
    makeInMemoryStore, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const pino = require('pino');

// --- Configuração do Firebase Admin ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log("[Firebase] Conectado ao Firebase Admin!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
}

// --- Configuração da IA ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- Configuração do Servidor Express ---
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};
const qrCodeDataStore = {}; 
const store = makeInMemoryStore(pino({ level: 'silent' }).child({ level: 'silent', stream: 'store' }));

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        frontendConnections[userId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

async function getOrCreateWhatsappClient(userId) {
    let sock = whatsappClients[userId];
    
    if (sock && sock.user) {
        return sock;
    }
    
    console.log(`[Sistema] Inicializando cliente Baileys para: ${userId}`);
    
    // --- IMPORTANTE: TENTA SALVAR A SESSÃO NO DISCO TEMPORÁRIO ---
    // Em produção, isso seria substituído por um banco de dados (Firestore)
    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_${userId}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['SuperApp', 'Chrome', '100.0.0']
    });

    store.bind(sock.ev);
    
    // --- Funções de Mensagens ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.key.fromMe && message.key.remoteJid !== 'status@broadcast' && message.remoteJid !== 'status@broadcast') {
            await handleNewMessage(message, userId);
        }
    });

    // --- Lógica de Conexão e QR Code ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                qrCodeDataStore[userId] = url; 
                sendEventToUser(userId, { type: 'qr', data: url });
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`[Baileys - ${userId}] Conexão fechada. Tentando reconectar: ${shouldReconnect}`);
            sendEventToUser(userId, { type: 'status', connected: false, status: 'Fechado/Desconectado' });
            if (shouldReconnect) {
                getOrCreateWhatsappClient(userId); 
            }
        } else if (connection === 'open') {
            console.log(`[Baileys - ${userId}] Conectado!`);
            delete qrCodeDataStore[userId];
            sendEventToUser(userId, { 
                type: 'status', 
                connected: true, 
                user: sock.user.name || sock.user.id.user 
            });
        }
    });
    
    sock.ev.on('creds.update', saveCreds);

    whatsappClients[userId] = sock;
    return sock;
}

// --- Funções Auxiliares do Baileys ---

async function handleNewMessage(message, userId) {
    const userContact = message.key.remoteJid;
    const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    
    if (!messageText || userContact === 'status@broadcast') return;

    try {
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return;
        
        let userData = userDoc.data();
        let leads = userData.leads || [];
        // Normaliza o número para o formato Baileys (user@s.whatsapp.net)
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => lead.whatsapp.includes(normalizedContact));

        // Lógica para não responder se o bot estiver desativado para este lead
        if (currentLead && currentLead.botActive === false) {
            console.log(`[Bot - ${userId}] Bot desativado para o lead ${currentLead.nome}. Ignorando mensagem.`);
            return;
        }

        // === CRIAÇÃO DE NOVO LEAD E ATENDIMENTO ===
        if (!currentLead) {
            console.log(`[CRM - ${userId}] Novo contato!`);
            
            // 1. Lógica da IA para extrair nome
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${messageText}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
            const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
            
            // 2. Cria o novo lead
            const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
            const newLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true }; 
            
            // 3. SALVA O NOVO LEAD NO FIREBASE
            await userDocRef.update({ leads: FieldValue.arrayUnion(newLead) });
            currentLead = newLead; 
            console.log(`[CRM - ${userId}] Novo lead "${leadName}" criado no Firestore!`);
        }

        // 4. Salva a mensagem do usuário no histórico do lead (Omitido por brevidade)
        // ...

        // 5. Gera resposta da IA
        const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
        const fullPrompt = `${botInstructions}\n\nMensagem do cliente: "${messageText}"`;
        const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();
        
        // 6. Envia a resposta pelo WhatsApp
        await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponse });

    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro ao processar mensagem:`, error);
    }
}

// --- Endpoints para o Frontend (Super App) ---

app.get('/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ connected: false, error: 'userId é obrigatório' });
    
    const sock = await getOrCreateWhatsappClient(userId);

    const isConnected = (sock.user && sock.user.id);

    if (!isConnected && qrCodeDataStore[userId]) {
        return res.status(200).json({ 
            connected: false, 
            status: 'QR_AVAILABLE', 
            qrCodeUrl: qrCodeDataStore[userId] 
        });
    }
    
    return res.status(200).json({ 
        connected: isConnected, 
        user: isConnected ? sock.user.name : 'Dispositivo',
        status: isConnected ? 'CONNECTED' : 'CLOSED'
    });
});

app.post('/send', async (req, res) => {
    const { to, text, userId } = req.body;
    if (!to || !text || !userId) return res.status(400).json({ ok: false, error: 'Campos to, text e userId são obrigatórios.' });
    
    const sock = whatsappClients[userId];
    if (!sock || !sock.user) {
        return res.status(400).json({ ok: false, error: 'O cliente WhatsApp não está conectado.' });
    }

    try {
        const normalizedTo = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(normalizedTo, { text: text });
        return res.status(200).json({ ok: true, message: 'Mensagem enviada com sucesso!' });
    } catch (error) {
        console.error(`Erro ao enviar mensagem para ${to}:`, error);
        return res.status(500).json({ ok: false, error: `Falha no envio da mensagem: ${error.message}` });
    }
});


app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };

    getOrCreateWhatsappClient(userId);

    req.on('close', () => delete frontendConnections[userId]);
});

// Endpoint de boas-vindas
app.get('/', (req, res) => {
    res.status(200).json({ status: "Bot está ativo. Migrado para Baileys." });
});

app.listen(port, () => console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`));
