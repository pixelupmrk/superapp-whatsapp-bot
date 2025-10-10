const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- PASSO 1: INICIALIZAÇÃO DO FIREBASE ADMIN ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    console.log("[Firebase] Conectado ao Firebase Admin com sucesso!");
} catch (error) {
    console.error("[Firebase] ERRO: Não foi possível ler as credenciais do Firebase. Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
}
const db = getFirestore();
// ---------------------------------------------

// --- Configuração da IA do Gemini ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// ------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        const eventString = `data: ${JSON.stringify(data)}\n\n`;
        frontendConnections[userId].res.write(eventString);
    }
}

function createWhatsappClient(userId) {
    console.log(`[Sistema] Criando cliente de WhatsApp para o usuário: ${userId}`);
    const client = new Client({ authStrategy: new LocalAuth({ clientId: userId }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });

    client.on('qr', (qr) => {
        console.log(`[WhatsApp - ${userId}] QR Code recebido.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) return console.error(`[QRCode - ${userId}] Erro:`, err);
            sendEventToUser(userId, { type: 'qr', data: url });
        });
    });

    client.on('ready', () => {
        console.log(`[WhatsApp - ${userId}] Cliente está pronto e conectado!`);
        sendEventToUser(userId, { type: 'status', data: 'Conectado ao WhatsApp!' });
    });

    // --- PASSO 2: LÓGICA DE CRIAÇÃO DE CARDS ---
    client.on('message', async (message) => {
        const userMessage = message.body;
        const userContact = message.from;
        console.log(`[WhatsApp - ${userId}] Mensagem de ${userContact}: ${userMessage}`);

        if (message.isStatus || message.from.includes('@g.us') || message.fromMe) return;

        try {
            // Verifica se o contato já existe como um lead para este usuário
            const userDocRef = db.collection('userData').doc(userId);
            const userDoc = await userDocRef.get();
            const userData = userDoc.exists ? userDoc.data() : { leads: [] };
            const leads = userData.leads || [];
            
            const existingLead = leads.find(lead => lead.whatsapp === userContact);

            if (!existingLead) {
                // Se o lead NÃO existe, cria um novo
                console.log(`[CRM - ${userId}] Novo contato! Tentando extrair informações...`);

                const prompt = `Analise a primeira mensagem de um cliente e extraia o nome dele. A mensagem é: "${userMessage}". Responda apenas com o nome mais provável, sem frases extras. Se não encontrar um nome, responda "Cliente Novo".`;
                const result = await model.generateContent(prompt);
                const leadName = (await result.response).text().trim();
                
                const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
                const newLead = {
                    id: nextId,
                    nome: leadName,
                    whatsapp: userContact,
                    status: 'novo' // Define o status inicial como 'novo'
                };

                // Adiciona o novo lead ao array e salva no Firestore
                const updatedLeads = [...leads, newLead];
                await userDocRef.set({ leads: updatedLeads }, { merge: true });
                console.log(`[CRM - ${userId}] Novo lead "${leadName}" criado e salvo no Firestore!`);

                // Envia notificação para o dono do bot
                const notification = `⭐ Novo Lead no Super App!\n\n*Nome:* ${leadName}\n*Contato:* ${userContact.split('@')[0]}\n*Mensagem:* "${userMessage}"`;
                await client.sendMessage(client.info.wid._serialized, notification);
                console.log(`[Notificação - ${userId}] Notificação de novo lead enviada.`);
            }

            // Responde ao cliente usando a IA
            const aiResponse = (await (await model.generateContent(userMessage)).response).text();
            await message.reply(aiResponse);
            console.log(`[Gemini - ${userId}] Resposta enviada para o cliente.`);

        } catch (error) {
            console.error(`[Sistema - ${userId}] Erro grave no processamento da mensagem:`, error);
            await message.reply("Desculpe, estou com um problema interno. Tente novamente em alguns instantes.");
        }
    });
    // ---------------------------------------------
    
    client.on('disconnected', (reason) => {
        console.log(`[WhatsApp - ${userId}] Cliente desconectado:`, reason);
        delete whatsappClients[userId];
    });

    client.initialize();
    whatsappClients[userId] = client;
    return client;
}

app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };
    console.log(`[Servidor] Frontend do usuário ${userId} conectado.`);
    if (!whatsappClients[userId]) {
        createWhatsappClient(userId);
    } else {
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
