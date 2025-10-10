const express = require('express');
const cors = require('cors'); // Dependência para corrigir o erro de conexão
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- Configuração do Firebase Admin (se você usa no backend) ---
// Se você não usa, pode remover esta parte.
// const serviceAccount = require('./caminho/para/seu/arquivo-de-credenciais.json');
// initializeApp({ credential: cert(serviceAccount) });
// const db = getFirestore();
// --------------------------------------------------------------------

const app = express();
app.use(cors()); // Linha MAIS IMPORTANTE: Habilita o CORS para aceitar conexões
app.use(express.json());

const port = process.env.PORT || 10000;

// Inicia o cliente do WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.initialize();

// --- Armazenamento dos eventos para o frontend ---
let clients = []; // Lista de conexões do frontend

// Endpoint para o frontend se conectar e ouvir os eventos
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    clients.push(newClient);
    console.log(`[Servidor] Cliente ${clientId} conectado.`);

    req.on('close', () => {
        console.log(`[Servidor] Cliente ${clientId} desconectado.`);
        clients = clients.filter(c => c.id !== clientId);
    });
});

// Função para enviar eventos para todos os frontends conectados
function sendEvent(data) {
    const eventString = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => client.res.write(eventString));
}

// --- Eventos do WhatsApp ---
client.on('qr', (qr) => {
    console.log('[WhatsApp] QR Code recebido, gerando imagem...');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('[QRCode] Erro ao gerar QR Code:', err);
            return;
        }
        sendEvent({ type: 'qr', data: url });
    });
});

client.on('ready', () => {
    console.log('[WhatsApp] Cliente está pronto e conectado!');
    sendEvent({ type: 'status', data: 'Conectado ao WhatsApp!' });
});

client.on('message', message => {
	console.log('[WhatsApp] Mensagem recebida:', message.body);
	if(message.body === '!ping') {
		message.reply('pong');
	}
});

app.listen(port, () => {
    console.log(`[Servidor] Servidor web rodando na porta ${port}.`);
    console.log(`[Servidor] Seu serviço está no ar ✨`);
});
