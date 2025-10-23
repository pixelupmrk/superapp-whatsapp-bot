const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- Configuração do Firebase Admin ---
try {
    // Certifique-se de que FIREBASE_SERVICE_ACCOUNT está configurado no Render
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    console.log("[Firebase] Conectado ao Firebase Admin!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
    // Se a inicialização falhar, o bot não pode se conectar ao Firestore, mas o servidor Express deve continuar rodando.
}
const db = getFirestore();

// --- Configuração da IA ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- Configuração do Servidor Express ---
const app = express();
// Configura CORS para permitir acesso de qualquer origem (NECESSÁRIO para o Vercel)
app.use(cors({ origin: true })); 
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};

// --- Funções de Comunicação ---

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        frontendConnections[userId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Obtém o cliente de WhatsApp, criando-o se não existir
function getOrCreateWhatsappClient(userId) {
    if (whatsappClients[userId] && whatsappClients[userId].getState() !== 'STOPPED') {
        return whatsappClients[userId];
    }
    
    console.log(`[Sistema] Criando novo cliente de WhatsApp para: ${userId}`);
    const client = new Client({ 
        authStrategy: new LocalAuth({ clientId: userId }), 
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        } 
    });

    client.on('qr', (qr) => qrcode.toDataURL(qr, (err, url) => sendEventToUser(userId, { type: 'qr', data: url })));
    
    client.on('ready', () => {
        sendEventToUser(userId, { type: 'status', connected: true, user: client.info.pushname || client.info.wid.user });
    });
    
    client.on('disconnected', (reason) => {
        console.log(`[WhatsApp - ${userId}] Cliente desconectado:`, reason);
        sendEventToUser(userId, { type: 'status', connected: false, status: 'disconnected' });
        // Não deletamos o cliente imediatamente para permitir a reconexão
    });

    client.initialize().catch(err => console.error(`[${userId}] Falha ao inicializar o cliente W.A:`, err));
    whatsappClients[userId] = client;
    return client;
}

// --- Lógica de Mensagens (IA) ---

client.on('message', async (message) => {
    // [Lógica completa de mensagens omitida por brevidade, mas deve estar no seu bot no Render]
    // ...
});

// --- Endpoints para o Frontend (Super App) ---

// NOVO ENDPOINT: Status do Bot (retorna JSON para o Frontend)
app.get('/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        // RESPOSTA CORRETA EM JSON
        return res.status(400).json({ connected: false, error: 'userId é obrigatório' });
    }
    
    const client = whatsappClients[userId];
    
    if (client) {
        const state = await client.getState();
        const isConnected = state === 'CONNECTED';
        
        // RESPOSTA CORRETA EM JSON
        return res.status(200).json({ 
            connected: isConnected, 
            user: isConnected ? client.info.pushname : 'Dispositivo',
            status: isConnected ? 'CONNECTED' : state
        });
    } else {
        // Força a criação/inicialização do cliente para que ele comece a gerar o QR/Status
        getOrCreateWhatsappClient(userId); 
        
        // RESPOSTA CORRETA EM JSON
        return res.status(200).json({ connected: false, status: 'Aguardando inicialização do cliente...' });
    }
});

// NOVO ENDPOINT: Envio de Mensagem (POST /send)
app.post('/send', async (req, res) => {
    const { to, text, userId } = req.body;
    if (!to || !text || !userId) {
        return res.status(400).json({ ok: false, error: 'Campos to, text e userId são obrigatórios.' });
    }
    
    const client = whatsappClients[userId];
    
    if (!client || (await client.getState()) !== 'CONNECTED') {
        return res.status(400).json({ ok: false, error: 'O cliente WhatsApp não está conectado. Verifique o status.' });
    }

    try {
        await client.sendMessage(to, text);
        return res.status(200).json({ ok: true, message: 'Mensagem enviada com sucesso!' });
    } catch (error) {
        console.error(`Erro ao enviar mensagem para ${to}:`, error);
        return res.status(500).json({ ok: false, error: `Falha no envio da mensagem: ${error.message}` });
    }
});


app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        // RESPOSTA CORRETA EM JSON
        return res.status(400).json({ error: 'userId é obrigatório' });
    }
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };

    // Inicia o cliente se não estiver rodando (isso fará o cliente emitir o status e o QR Code, se necessário)
    getOrCreateWhatsappClient(userId);

    req.on('close', () => delete frontendConnections[userId]);
});

// Endpoint de teste (Se o Render retornar HTML no /status, ele provavelmente está enviando a resposta padrão, o que é um erro)
app.get('/', (req, res) => {
    res.status(200).send("Seu serviço está rodando no ar (versão corrigida).");
});

app.listen(port, () => console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`));
