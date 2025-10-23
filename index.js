const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- Configuração do Firebase Admin ---
let db;
try {
    // Certifique-se de que FIREBASE_SERVICE_ACCOUNT está configurado no Render
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
// Configura CORS para permitir acesso de qualquer origem (NECESSÁRIO para o Vercel)
app.use(cors({ origin: true })); 
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};
const qrCodeDataStore = {}; // NOVO: Armazenamento temporário do último QR Code gerado

// --- Funções de Comunicação e Criação do Cliente ---

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        frontendConnections[userId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Obtém o cliente de WhatsApp, criando-o e inicializando-o se não existir
function getOrCreateWhatsappClient(userId) {
    // Se o cliente já existe e está pronto, retorna.
    if (whatsappClients[userId] && whatsappClients[userId].getState() !== 'STOPPED') {
        return whatsappClients[userId];
    }
    
    console.log(`[Sistema] Criando novo cliente de WhatsApp para: ${userId}`);
    const client = new Client({ 
        authStrategy: new LocalAuth({ clientId: userId }), 
        // Args de Puppeteer para Render/produção - Crucial para resolver erros de ambiente
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-mhtml-generation'] 
        } 
    });

    // Eventos
    client.on('qr', (qr) => qrcode.toDataURL(qr, (err, url) => {
        qrCodeDataStore[userId] = url; // SALVA A URL DO QR CODE
        sendEventToUser(userId, { type: 'qr', data: url });
    }));
    client.on('ready', () => {
        delete qrCodeDataStore[userId]; // Limpa o QR Code quando conectado
        sendEventToUser(userId, { type: 'status', connected: true, user: client.info.pushname || client.info.wid.user });
    });
    client.on('disconnected', (reason) => {
        console.log(`[WhatsApp - ${userId}] Cliente desconectado:`, reason);
        sendEventToUser(userId, { type: 'status', connected: false, status: 'disconnected' });
    });
    
    // === LÓGICA DE MENSAGENS E IA ===
    client.on('message', async (message) => {
        const userContact = message.from;
        console.log(`[WhatsApp - ${userId}] Mensagem de ${userContact}: ${message.body}`);
        if (message.isStatus || message.from.includes('@g.us') || message.fromMe) return;

        try {
            if (!db) {
                console.error(`[Sistema - ${userId}] Firestore não inicializado. Não é possível processar a mensagem.`);
                return;
            }

            const userDocRef = db.collection('userData').doc(userId);
            const userDoc = await userDocRef.get();
            if (!userDoc.exists) {
                console.log(`[Sistema - ${userId}] Documento do usuário não encontrado.`);
                return;
            }
            
            let userData = userDoc.data();
            let leads = userData.leads || [];
            let currentLead = leads.find(lead => lead.whatsapp === userContact);
            let leadId;

            if (currentLead && currentLead.botActive === false) {
                console.log(`[Bot - ${userId}] Bot desativado para o lead ${currentLead.nome}. Ignorando mensagem.`);
                return;
            }

            if (!currentLead) {
                console.log(`[CRM - ${userId}] Novo contato!`);
                
                const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
                const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${message.body}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
                
                const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
                
                const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
                const newLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true }; 
                leadId = nextId;
                
                await userDocRef.update({ leads: FieldValue.arrayUnion(newLead) });
                console.log(`[CRM - ${userId}] Novo lead "${leadName}" criado!`);
                currentLead = newLead; 
            } else {
                leadId = currentLead.id;
            }

            await db.collection('userData').doc(userId).collection('leads').doc(String(leadId))
                      .collection('messages').add({ text: message.body, sender: 'lead', timestamp: new Date() });

            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const fullPrompt = `${botInstructions}\n\nMensagem do cliente: "${message.body}"`;
            const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();
            
            await message.reply(aiResponse);

            await db.collection('userData').doc(userId).collection('leads').doc(String(leadId))
                      .collection('messages').add({ text: aiResponse, sender: 'operator', timestamp: new Date() });

        } catch (error) {
            console.error(`[Sistema - ${userId}] Erro no processamento da mensagem:`, error);
        }
    });
    // === FIM DA LÓGICA DE MENSAGENS E IA ===

    client.initialize().catch(err => console.error(`[${userId}] Falha ao inicializar o cliente:`, err));
    whatsappClients[userId] = client;
    return client;
}

// --- Endpoints para o Frontend (Super App) ---

app.get('/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ connected: false, error: 'userId é obrigatório' });
    }
    
    const client = whatsappClients[userId];
    
    if (client) {
        try {
            // Se client.pupPage for null/undefined, ele ainda não está pronto. 
            if (!client.pupPage) {
                return res.status(200).json({ connected: false, status: 'OPENING', detail: 'Aguardando inicialização do navegador...' });
            }
            
            const state = await client.getState();
            const isConnected = state === 'CONNECTED';
            
            return res.status(200).json({ 
                connected: isConnected, 
                user: isConnected ? client.info.pushname : 'Dispositivo',
                status: isConnected ? 'CONNECTED' : state
            });
        } catch (e) {
            // Se getState ou info falhar (erro no Puppeteer/Estado)
            return res.status(200).json({ connected: false, status: 'Cliente offline (Erro Interno).' });
        }
    } else {
        // Força a criação/inicialização do cliente para que ele comece a gerar o QR/Status
        getOrCreateWhatsappClient(userId); 
        return res.status(200).json({ connected: false, status: 'Aguardando inicialização do cliente...' });
    }
});

app.post('/send', async (req, res) => {
    const { to, text, userId } = req.body;
    if (!to || !text || !userId) {
        return res.status(400).json({ ok: false, error: 'Campos to, text e userId são obrigatórios.' });
    }
    
    const client = whatsappClients[userId];
    
    // Verificação de conexão mais segura
    if (!client || client.getState() !== 'CONNECTED') {
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
        return res.status(400).json({ error: 'userId é obrigatório' });
    }
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };

    getOrCreateWhatsappClient(userId);

    req.on('close', () => delete frontendConnections[userId]);
});

// NOVO ENDPOINT: Rota para exibir o QR Code para teste manual
app.get('/qrcode-test', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).send("<html><body><h2>Erro</h2><p>Parâmetro <code>userId</code> é obrigatório. Use: <code>/qrcode-test?userId=SEU_ID</code></p></body></html>");
    }

    getOrCreateWhatsappClient(userId); // Garante que o cliente esteja inicializando e tentando gerar o QR Code

    // Espera um pouco para o evento de QR Code ser disparado (assíncrono)
    await new Promise(resolve => setTimeout(resolve, 5000)); 

    const qrUrl = qrCodeDataStore[userId];

    if (qrUrl) {
        // Exibe o QR Code como uma imagem no navegador
        return res.status(200).send(`
            <html>
                <body style="background-color: #1a1a2e; color: #cdd6f4; text-align: center; padding: 50px;">
                    <h2>Escaneie o QR Code para Conectar o Bot!</h2>
                    <img src="${qrUrl}" alt="QR Code do WhatsApp" style="border: 5px solid #00f7ff; max-width: 300px;"/>
                    <p style="margin-top: 20px;">Este QR Code é válido por pouco tempo. Escaneie agora.</p>
                </body>
            </html>
        `);
    } else {
        // Verifica o status do cliente para dar feedback
        const client = whatsappClients[userId];
        const state = client ? (client.pupPage ? await client.getState() : 'INICIALIZANDO') : 'NÃO ENCONTRADO';

        if (state === 'CONNECTED') {
             return res.status(200).send(`<html><body style="background-color: #1a1a2e; color: #25D366; text-align: center; padding: 50px;"><h2>BOT JÁ CONECTADO!</h2><p>Usuário: ${client.info.pushname}</p><p>Estado: ${state}</p></body></html>`);
        } else {
             return res.status(200).send(`<html><body style="background-color: #1a1a2e; color: #ffc107; text-align: center; padding: 50px;"><h2>Aguarde</h2><p>Estado atual: ${state}</p><p>Aguarde e recarregue a página em alguns segundos. O Render Free está iniciando o navegador.</p></body></html>`);
        }
    }
});

// Endpoint de boas-vindas para garantir que o /status não retorne HTML
app.get('/', (req, res) => {
    res.status(200).json({ status: "Bot está ativo. Use /status ou /events." });
});

app.listen(port, () => console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`));
