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

        // === CRIAÇÃO DE NOVO LEAD ===
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
        
        // --- INÍCIO DA LÓGICA CRÍTICA DE SALVAMENTO E NOTIFICAÇÃO ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
        
        // 1. SALVA A MENSAGEM RECEBIDA DO CLIENTE (role: 'user')
        await chatRef.add({
            role: "user",
            parts: [{text: messageText}],
            timestamp: FieldValue.serverTimestamp(),
        });
        
        // 2. INCREMENTA O CONTADOR (Bolinha de Notificação)
        const leadIndex = leads.findIndex(l => l.id === currentLead.id);
        if (leadIndex !== -1) {
             leads[leadIndex].unreadCount = (leads[leadIndex].unreadCount || 0) + 1;
        }

        // --- LÓGICA CONDICIONAL DE RESPOSTA DA IA ---
        if (currentLead.botActive === true) {
            
            console.log(`[Bot - ${userId}] Bot ativo. Gerando resposta para ${currentLead.nome}.`);
            
            // NOVO: ESTRUTURAÇÃO DA RESPOSTA DA IA PARA POSSÍVEL AGENDAMENTO
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo e focado em triagem e agendamento.";
            
            const fullPrompt = `${botInstructions}\n\nAnalise a mensagem do cliente: "${messageText}". Responda de forma envolvente, mas seu foco principal é extrair a DATA e HORA de um possível agendamento ou follow-up.

            Se você identificar no chat uma intenção clara de agendamento (Ex: "amanhã às 14h", "quarta-feira 10h"), inclua a instrução de agendamento no seu comando de saída (JSON).

            Instrução Final: O resultado deve ser um JSON com a chave 'response_text' (sua resposta de chat) e, *opcionalmente*, a chave 'schedule_info' se houver dados de agendamento. Se não houver agendamento, retorne apenas a chave 'response_text'.`;

            const aiResponseResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "object",
                        properties: {
                            response_text: {
                                type: "string",
                                description: "A resposta amigável e persuasiva para o cliente no WhatsApp (Obrigatório)."
                            },
                            scheduledDate: {
                                type: "string",
                                description: "A data do agendamento encontrada (Ex: '2025-10-26'). Se não houver, omita."
                            },
                            scheduledTime: {
                                type: "string",
                                description: "A hora do agendamento encontrada (Ex: '14:30'). Se não houver, omita."
                            },
                            reminderType: {
                                type: "string",
                                description: "O tipo de compromisso (Ex: 'followup' ou 'meeting'). Se agendado, use 'followup'."
                            }
                        },
                        required: ["response_text"]
                    }
                }
            });
            
            const aiResponseJson = JSON.parse(aiResponseResult.text);
            const aiResponseText = aiResponseJson.response_text;
            
            // 4. ATUALIZAÇÃO DO LEAD COM A AGENDA (SE HOUVER)
            if (aiResponseJson.scheduledDate && aiResponseJson.scheduledTime) {
                
                // Atualiza o lead localmente
                leads[leadIndex].scheduledDate = aiResponseJson.scheduledDate;
                leads[leadIndex].scheduledTime = aiResponseJson.scheduledTime;
                leads[leadIndex].reminderType = aiResponseJson.reminderType || 'followup';

                console.log(`[Agendador] Lead ${currentLead.nome} agendado para ${aiResponseJson.scheduledDate} ${aiResponseJson.scheduledTime}`);
            }

            // 5. SALVA A RESPOSTA DA IA (role: 'model')
            await chatRef.add({
                role: "model",
                parts: [{text: aiResponseText}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // 6. Envia a resposta pelo WhatsApp (só se o Bot estiver ativo)
            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponseText });

        } else {
            console.log(`[Bot - ${userId}] Bot desativado para ${currentLead.nome}. Apenas salvando no histórico.`);
        }
        
        // 7. ATUALIZAÇÃO FINAL DO ARRAY DE LEADS NO FIRESTORE (Salva agenda e/ou contador)
        await userDocRef.update({ leads: leads });
        
        // 8. NOTIFICA O FRONT-END PARA RECARREGAR A LISTA (Devido ao novo lead ou contador/agenda)
        sendEventToUser(userId, { type: 'message', from: userContact });


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
