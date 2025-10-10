const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuração da IA do Gemini ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada no Render.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// ------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 10000;

// Objeto para gerenciar múltiplos clientes de WhatsApp
// A chave será o ID do usuário (ex: "user-abc-123")
const whatsappClients = {};
const frontendConnections = {}; // Armazena as conexões SSE dos frontends

// Função para enviar eventos para um frontend específico
function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        const eventString = `data: ${JSON.stringify(data)}\n\n`;
        frontendConnections[userId].res.write(eventString);
    }
}

// Função para criar e inicializar um novo cliente de WhatsApp para um usuário
function createWhatsappClient(userId) {
    console.log(`[Sistema] Criando novo cliente de WhatsApp para o usuário: ${userId}`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }), // Salva a sessão em uma pasta única para este usuário
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`[WhatsApp - ${userId}] QR Code recebido.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) return console.error(`[QRCode - ${userId}] Erro ao gerar QR Code:`, err);
            sendEventToUser(userId, { type: 'qr', data: url });
        });
    });

    client.on('ready', () => {
        console.log(`[WhatsApp - ${userId}] Cliente está pronto e conectado!`);
        sendEventToUser(userId, { type: 'status', data: 'Conectado ao WhatsApp!' });
    });

    client.on('message', async (message) => {
        const userMessage = message.body;
        console.log(`[WhatsApp - ${userId}] Mensagem recebida de ${message.from}: ${userMessage}`);
        if (message.isStatus || message.from.includes('@g.us') || message.fromMe) return;

        try {
            const result = await model.generateContent(userMessage);
            const response = await result.response;
            const aiResponse = response.text();
            console.log(`[Gemini - ${userId}] Resposta da IA: ${aiResponse}`);
            await message.reply(aiResponse);
        } catch (error) {
            console.error(`[Gemini - ${userId}] Erro:`, error);
            await message.reply("Desculpe, estou com um problema para me conectar à minha inteligência.");
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log(`[WhatsApp - ${userId}] Cliente foi desconectado! Razão:`, reason);
        delete whatsappClients[userId]; // Remove da lista para poder reconectar
    });

    client.initialize();
    whatsappClients[userId] = client;
    return client;
}


// Endpoint para o frontend se conectar e ouvir os eventos
// Agora ele espera um ID de usuário: /events?userId=abc-123
app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    frontendConnections[userId] = { res };
    console.log(`[Servidor] Frontend do usuário ${userId} conectado.`);

    // Inicia a conexão do WhatsApp para este usuário se ainda não existir
    if (!whatsappClients[userId]) {
        createWhatsappClient(userId);
    } else {
        // Se já existe, envia o status atual
        sendEventToUser(userId, { type: 'status', data: 'Conexão já estabelecida.' });
    }

    req.on('close', () => {
        console.log(`[Servidor] Frontend do usuário ${userId} desconectado.`);
        delete frontendConnections[userId];
    });
});

app.listen(port, () => {
    console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`);
});
