const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuração da IA do Gemini ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada no Render.");
}
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// ------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 10000;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.initialize();

let clients = [];

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    clients.push({ id: clientId, res });
    console.log(`[Servidor] Cliente ${clientId} conectado.`);

    req.on('close', () => {
        console.log(`[Servidor] Cliente ${clientId} desconectado.`);
        clients = clients.filter(c => c.id !== clientId);
    });
});

function sendEvent(data) {
    const eventString = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => client.res.write(eventString));
}

client.on('qr', (qr) => {
    console.log('[WhatsApp] QR Code recebido, gerando imagem...');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) return console.error('[QRCode] Erro ao gerar QR Code:', err);
        sendEvent({ type: 'qr', data: url });
    });
});

client.on('ready', () => {
    console.log('[WhatsApp] Cliente está pronto e conectado!');
    sendEvent({ type: 'status', data: 'Conectado ao WhatsApp!' });
});

// --- LÓGICA DE RESPOSTA DO BOT ---
client.on('message', async (message) => {
    const userMessage = message.body;
    console.log(`[WhatsApp] Mensagem recebida de ${message.from}: ${userMessage}`);

    // Ignora mensagens de status, grupos e as próprias mensagens do bot
    if (message.isStatus || message.from.includes('@g.us') || message.fromMe) {
        return;
    }

    try {
        // Envia a mensagem do usuário para a IA
        console.log('[Gemini] Enviando prompt para a IA...');
        const result = await model.generateContent(userMessage);
        const response = await result.response;
        const aiResponse = response.text();
        
        // Envia a resposta da IA de volta para o usuário no WhatsApp
        console.log(`[Gemini] Resposta da IA: ${aiResponse}`);
        await message.reply(aiResponse);

    } catch (error) {
        console.error('[Gemini] Erro ao processar a mensagem com a IA:', error);
        await message.reply("Desculpe, estou com um problema para me conectar à minha inteligência. Tente novamente em alguns instantes.");
    }
});
// ---------------------------------

app.listen(port, () => {
    console.log(`[Servidor] Servidor web rodando na porta ${port}.`);
    console.log(`[Servidor] Seu serviço está no ar ✨`);
});
