// index.js CORRIGIDO COM ESTOQUE E GEMINI 2.5 FLASH
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // MODELO ESPECIFICADO: gemini-2.5-flash
console.log("[IA] Modelo Gemini 2.5 Flash configurado.");

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

// --- Funções do Sistema Baileys ---

function deleteAuthFiles(userId) {
    const authPath = path.join(process.cwd(), `baileys_auth_${userId}`);
    console.log(`[Sistema] Tentando deletar arquivos de autenticação para ${userId}: ${authPath}`);
    try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log(`[Sistema] Arquivos de autenticação deletados para ${userId}.`);
    } catch (err) {
        console.error(`[Sistema] Erro ao deletar arquivos de autenticação para ${userId}:`, err.message);
    }
}

async function getOrCreateWhatsappClient(userId) {
    let sock = whatsappClients[userId];
    
    if (sock && sock.user && sock.ws.readyState === sock.ws.OPEN) {
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
    
    // LÓGICA DE MENSAGENS
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (message.key.remoteJid === 'status@broadcast') return;

        if (!message.key.fromMe) {
            await handleNewMessage(message, userId);
        } else if (message.key.fromMe) {
            await handleOutgoingMessage(message, userId);
        }
    });

    // LÓGICA DE RECONEXÃO
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
            } else {
                console.log(`[Baileys - ${userId}] Logout Permanente. Deletando credenciais para novo login.`);
                deleteAuthFiles(userId);
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


// --- Funções Auxiliares do Bot e IA ---

async function getEstoqueInfo(userData) {
    const estoque = userData.estoque || [];
    if (estoque.length === 0) return "";
    
    let info = "INFORMAÇÃO DE ESTOQUE ATUAL: Use esta lista para responder sobre produtos ou preços. NÃO REVELE CUSTOS.";
    
    estoque.forEach(p => {
        const produtoNome = p.produto || 'Item';
        // Confere se o preço de venda é um número antes de usar toFixed(2)
        const preco = (typeof p.venda === 'number' && !isNaN(p.venda)) ? `R$${p.venda.toFixed(2)}` : 'Preço N/A';
        
        // Apenas Produto e Venda são expostos.
        info += `[Produto: ${produtoNome} | Preço de Venda ao Cliente: ${preco}]; `;
    });
    
    return info + " Nunca mencione o valor de compra ou custos internos.";
}


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
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => (lead.whatsapp || '').includes(normalizedContact));
        let isNewLead = false;

        // === 1. CRIAÇÃO DE NOVO LEAD ===
        if (!currentLead) {
            isNewLead = true;
            console.log(`[CRM - ${userId}] Novo contato!`);
            
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${messageText}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
            const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
            
            const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
            currentLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true, unreadCount: 0 }; 
            
            leads.push(currentLead);
        }
        
        // --- 2. LÓGICA DE SALVAMENTO E NOTIFICAÇÃO (SEMPRE ACONTECE) ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
        
        // SALVA A MENSAGEM RECEBIDA DO CLIENTE (role: 'user')
        await chatRef.add({
            role: "user",
            parts: [{text: messageText}],
            timestamp: FieldValue.serverTimestamp(),
        });
        
        const leadIndex = leads.findIndex(l => l.id === currentLead.id);
        if (leadIndex !== -1) {
             leads[leadIndex].unreadCount = (leads[leadIndex].unreadCount || 0) + 1;
        }

        await userDocRef.update({ leads: leads });
        
        sendEventToUser(userId, { type: 'message', from: userContact });

        // --- 3. LÓGICA CONDICIONAL DE RESPOSTA DA IA ---
        if (currentLead.botActive === true) {
            
            console.log(`[Bot - ${userId}] Bot ativo. Gerando resposta para ${currentLead.nome}.`);
            
            // BUSCA E FORMATA O ESTOQUE
            const estoqueInfo = await getEstoqueInfo(userData);
            
            // CRIA O PROMPT COMPLETO
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const fullPrompt = `${botInstructions}\n\n${estoqueInfo}\n\nMensagem do cliente: "${messageText}"`;
            
            const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();
            
            // SALVA A RESPOSTA DA IA (role: 'model')
            await chatRef.add({
                role: "model",
                parts: [{text: aiResponse}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Envia a resposta pelo WhatsApp 
            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponse });

        } else {
            console.log(`[Bot - ${userId}] Bot desativado para ${currentLead.nome}. Apenas salvando no histórico.`);
        }

    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro ao processar mensagem (handleNewMessage):`, error);
    }
}


async function handleOutgoingMessage(message, userId) {
    const userContact = message.key.remoteJid;
    const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    
    if (!messageText || userContact === 'status@broadcast') return;

    try {
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return;

        let userData = userDoc.data();
        let leads = userData.leads || [];
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => (lead.whatsapp || '').includes(normalizedContact));

        if (!currentLead) return; 

        // Só salve se o bot estiver INATIVO (ou seja, se a mensagem foi enviada pelo celular)
        if (currentLead.botActive === false) {
            
            console.log(`[Sistema - ${userId}] Salvando mensagem manual (do celular) para ${currentLead.nome}`);
            
            const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
            
            // SALVA A MENSAGEM (role: 'model' para o lado do negócio/atendente)
            await chatRef.add({
                role: "model",
                parts: [{text: messageText}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Limpa o contador de não lidas quando você responde
            const leadIndex = leads.findIndex(l => l.id === currentLead.id);
            if (leadIndex !== -1 && (leads[leadIndex].unreadCount || 0) > 0) {
                leads[leadIndex].unreadCount = 0;
                await userDocRef.update({ leads: leads });
                sendEventToUser(userId, { type: 'message', from: userContact });
            }
        }
        
    } catch (error) {
        console.error(`[Sistema - ${userId}] Erro ao processar mensagem enviada (handleOutgoingMessage):`, error);
    }
}


// --- Endpoints para o Frontend (Super App) ---

app.get('/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ connected: false, error: 'userId é obrigatório' });
    
    const sock = await getOrCreateWhatsappClient(userId);
    const isConnected = (sock.user && sock.ws.readyState === sock.ws.OPEN);

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

// ENDPOINT /send ATUALIZADO
app.post('/send', async (req, res) => {
    // AGORA EXIGE 'leadId' DO FRONTEND
    const { to, text, userId, leadId } = req.body;
    if (!to || !text || !userId || !leadId) { 
        return res.status(400).json({ ok: false, error: 'Campos to, text, userId e leadId são obrigatórios' });
    }
    
    const sock = whatsappClients[userId];
    if (!sock || !sock.user || sock.ws.readyState !== sock.ws.OPEN) { 
        return res.status(503).json({ ok: false, error: 'Connection Closed.', details: 'O cliente WhatsApp não está autenticado ou está desconectado.' });
    }

    try {
        // --- ETAPA DE SALVAR ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(leadId)).collection('chatHistory');
        await chatRef.add({
            role: "model", // "model" é usado para o lado do "negócio/atendente"
            parts: [{text: text}],
            timestamp: FieldValue.serverTimestamp(),
        });

        // 2. Limpa o contador de não lidas (Boa prática)
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (userDoc.exists) {
            let leads = userDoc.data().leads || [];
            const leadIndex = leads.findIndex(l => l.id === Number(leadId));
            if (leadIndex !== -1) {
                leads[leadIndex].unreadCount = 0; // Zera o contador
                await userDocRef.update({ leads: leads });
                // Notifica o front para atualizar a lista (remover a bolinha)
                sendEventToUser(userId, { type: 'message', from: to }); 
            }
        }
        // --- FIM DA ETAPA DE SALVAR ---

        // ETAPA DE ENVIAR (JÁ EXISTIA)
        const normalizedTo = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(normalizedTo, { text: text });
        
        return res.status(200).json({ ok: true, message: 'Mensagem enviada e salva com sucesso!' });
        
    } catch (error) {
        console.error(`Erro ao enviar/salvar mensagem para ${to}:`, error);
        return res.status(500).json({ ok: false, error: `Falha no envio/salvamento da mensagem: ${error.message}` });
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
