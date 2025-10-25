const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
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
// Modelo simples e robusto
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
    
    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_${userId}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['SuperApp', 'Chrome', '100.0.0']
    });

    store.bind(sock.ev);
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.key.fromMe && message.key.remoteJid !== 'status@broadcast' && message.remoteJid !== 'status@broadcast') {
            await handleNewMessage(message, userId);
        }
    });

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
    
    // --- LÓGICA ROBUSTA DE EXTRAÇÃO DE TEXTO (CORRIGE ERRO UNDEFINED) ---
    let messageText = '';
    const content = message.message; 
    
    if (content) {
        // Tenta obter o texto da conversa, extendedText, ou legenda de mídia
        messageText = content.conversation || 
                      content.extendedTextMessage?.text || 
                      content.imageMessage?.caption ||
                      content.videoMessage?.caption ||
                      content.documentMessage?.caption ||
                      ''; // Se não for texto ou legenda, retorna string vazia
    }
    
    // Garante que é uma String para o Firestore
    messageText = String(messageText).trim(); 
    
    if (userContact === 'status@broadcast') {
        return; 
    }
    
    // Se a mensagem é vazia, mas não é uma mídia, a tratamos como Mídia Recebida (para o histórico)
    if (messageText.length === 0 && content) {
        const isMedia = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage;
        const isSticker = content.stickerMessage;

        if (isMedia) {
            messageText = 'Mídia Recebida (Sem Legenda)';
        } else if (isSticker) {
            messageText = 'Sticker/Figurinha Recebida';
        } else {
             // Se for uma mensagem de sistema ou outro tipo desconhecido, ignoramos.
             return; 
        }
    } else if (messageText.length === 0) {
        return; // Ignora mensagens que são apenas espaços ou vazias sem mídia.
    }


    try {
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return;
        
        let userData = userDoc.data();
        let leads = userData.leads || [];
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => (lead.whatsapp || '').includes(normalizedContact));
        let isNewLead = false;

        // === 1. CRIAÇÃO DE NOVO LEAD ===
        if (!currentLead) {
            isNewLead = true;
            console.log(`[CRM - ${userId}] Novo contato!`);
            
            // Lógica da IA para extrair nome 
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${messageText}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
            const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
            
            const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
            currentLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true, unreadCount: 0 }; 
            
            leads.push(currentLead);
        }
        
        // --- 2. LÓGICA CRÍTICA DE SALVAMENTO E NOTIFICAÇÃO ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
        
        // SALVA A MENSAGEM RECEBIDA DO CLIENTE (role: 'user')
        await chatRef.add({
            role: "user",
            parts: [{text: messageText}], 
            timestamp: FieldValue.serverTimestamp(),
        });
        
        // INCREMENTA O CONTADOR (Bolinha de Notificação)
        const leadIndex = leads.findIndex(l => l.id === currentLead.id);
        if (leadIndex !== -1) {
             leads[leadIndex].unreadCount = (leads[leadIndex].unreadCount || 0) + 1;
        }

        // --- 3. LÓGICA CONDICIONAL DE RESPOSTA DA IA (Modo Conversação) ---
        let aiResponseText = ""; 
        
        if (currentLead.botActive === true) {
            
            console.log(`[Bot - ${userId}] Bot ativo. Gerando resposta para ${currentLead.nome}.`);
            
            // CHAMADA SIMPLES DA IA (Modo Conversação)
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo e focado em triagem e agendamento.";
            const fullPrompt = `${botInstructions}\n\nVocê está conversando com um cliente chamado ${currentLead.nome}. Mantenha a conversa natural, use negrito e emojis para destacar pontos-chave e tente fechar um agendamento ou follow-up.\n\nMensagem do cliente: "${messageText}"`;
            
            const aiResponseResult = await model.generateContent(fullPrompt);
            aiResponseText = aiResponseResult.text;
            
            // SALVA A RESPOSTA DA IA (role: 'model')
            await chatRef.add({
                role: "model",
                parts: [{text: aiResponseText}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Envia a resposta pelo WhatsApp (só se o Bot estiver ativo)
            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponseText });

        } else {
            console.log(`[Bot - ${userId}] Bot desativado para ${currentLead.nome}. Apenas salvando no histórico.`);
        }
        
        // 4. ATUALIZAÇÃO FINAL DO ARRAY DE LEADS NO FIRESTORE (Salva novo lead e/ou contador)
        await userDocRef.update({ leads: leads });
        
        // 5. NOTIFICA O FRONT-END PARA RECARREGAR A LISTA
        sendEventToUser(userId, { type: 'message', from: userContact });


    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro CRÍTICO ao processar mensagem:`, error);
        // Tenta salvar uma mensagem de erro no chat (para debug)
        await chatRef.add({
            role: "model",
            parts: [{text: "ERRO INTERNO: Falha ao processar a mensagem do cliente. Verifique os logs do Bot."}],
            timestamp: FieldValue.serverTimestamp(),
        });
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
    if (!to || !text || !userId) return res.status(400).json({ ok: false, error: 'Campos to, text e userId são obrigatórios' });
    
    const sock = whatsappClients[userId];
    if (!sock || !sock.user || sock.ws.readyState !== sock.ws.OPEN) { 
        return res.status(503).json({ ok: false, error: 'Connection Closed.', details: 'O cliente WhatsApp não está autenticado ou está desconectado.' });
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
