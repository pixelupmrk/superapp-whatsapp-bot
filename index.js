// === DEPENDÊNCIAS ===
const http = require('http');
const qrcode = require('qrcode');
const { Client } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// === CONFIGURAÇÕES ===
console.log('Lendo variáveis de ambiente...');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
const geminiApiKey = process.env.GEMINI_API_KEY;
const crmUserId = process.env.CRM_USER_ID;
console.log('Variáveis lidas com sucesso.');

// Inicializa Firebase
try {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${firebaseConfig.projectId}.firebaseio.com`
        });
        console.log('✅ Conectado ao Firebase!');
    }
} catch (error) {
    console.error('❌ ERRO AO CONECTAR COM FIREBASE:', error);
    process.exit(1);
}
const db = admin.firestore();

// Inicializa Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
// Alterado para 'gemini-2.5-flash' conforme solicitado
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
console.log('✅ Conectado à API do Gemini!');

// === VARIÁVEIS DE ESTADO ===
let qrCodeDataUrl = null;
let botStatus = "Iniciando...";

// === SERVIDOR WEB PARA EXIBIR O QR CODE ===
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (qrCodeDataUrl) {
        res.end(`
            <body style="background-color: #1a1a2e;">
                <div style="font-family: sans-serif; text-align: center; padding: 40px; color: #cdd6f4;">
                    <h1>Escaneie para Conectar</h1>
                    <p>Abra o WhatsApp no seu celular e escaneie a imagem abaixo.</p>
                    <img src="${qrCodeDataUrl}" alt="QR Code do WhatsApp" style="width: 300px; height: 300px; background-color: white; padding: 10px; border-radius: 8px;">
                    <p style="margin-top: 20px;">Após escanear, esta página será atualizada com a mensagem de confirmação.</p>
                </div>
            </body>
        `);
    } else {
        res.end(`
            <body style="background-color: #1a1a2e;">
                <div style="font-family: sans-serif; text-align: center; padding: 40px; color: #cdd6f4;">
                    <h1>SuperApp WhatsApp Bot</h1>
                    <p><strong>Status:</strong> ${botStatus}</p>
                    <p>Se o QR Code não aparecer em 30 segundos, atualize a página. Se o status for 'Desconectado', reinicie o serviço no painel da Render.</p>
                </div>
            </body>
        `);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Servidor web rodando na porta ${PORT}. Acesse a URL do seu serviço para ver o QR Code.`);
});

// === BOT DO WHATSAPP ===
const client = new Client({
    puppeteer: {
        headless: true,
        args: [ '--no-sandbox', '--disable-setuid-sandbox' ]
    }
});

client.on('qr', async (qr) => {
    console.log("QR Code recebido, gerando imagem...");
    botStatus = "Aguardando escaneamento do QR Code.";
    qrCodeDataUrl = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
    console.log('✅ Cliente WhatsApp conectado e pronto para trabalhar!');
    botStatus = "Conectado com sucesso! O bot já está funcionando.";
    qrCodeDataUrl = null; 
});

client.on('disconnected', (reason) => {
    console.log('❌ Cliente foi desconectado!', reason);
    botStatus = `Desconectado: ${reason}. Reiniciando...`;
    client.initialize();
});

const conversas = {};
let PROMPT_PADRAO = `Você é um assistente virtual. Sua função é fazer o pré-atendimento. Colete o nome, assunto, orçamento e prazo do cliente. Ao final, retorne um JSON com a chave "finalizado" como true e os dados coletados.`;

client.on('message', async message => {
    const contato = message.from;
    const textoRecebido = message.body;
    console.log(`Mensagem de ${contato}: "${textoRecebido}"`);
    if (message.isGroup) return;

    let promptDoUsuario = PROMPT_PADRAO;
    try {
        if (crmUserId) {
            const userDoc = await db.collection('userData').doc(crmUserId).get();
            if (userDoc.exists && userDoc.data().botPrompt) {
                promptDoUsuario = userDoc.data().botPrompt;
                console.log("Prompt personalizado carregado para o usuário.");
            } else {
                console.log("Nenhum prompt personalizado encontrado para o usuário, usando o padrão.");
            }
        }
    } catch (error) {
        console.error("Erro ao carregar prompt do usuário, usando o padrão:", error);
    }

    if (!conversas[contato]) {
        conversas[contato] = [
            { role: "user", parts: [{ text: promptDoUsuario }] },
            { role: "model", parts: [{ text: "Ok, entendi minhas instruções. Estou pronto para começar." }] }
        ];
    }
    
    conversas[contato].push({ role: "user", parts: [{ text: textoRecebido }] });

    try {
        const result = await geminiModel.generateContent({ contents: conversas[contato] });
        const respostaIA = result.response.text();
        console.log(`Resposta da IA: "${respostaIA}"`);
        
        conversas[contato].push({ role: "model", parts: [{ text: respostaIA }] });

        let dadosExtraidos;
        try {
            dadosExtraidos = JSON.parse(respostaIA);
        } catch (e) {
            await client.sendMessage(contato, respostaIA);
            return;
        }

        if (dadosExtraidos && dadosExtraidos.finalizado === true) {
            console.log("Conversa finalizada. Tentando salvar no CRM...");
            dadosExtraidos.whatsapp = contato.replace('@c.us', '');
            await adicionarLeadNoCRM(dadosExtraidos);
            const msgFinal = `Obrigado, ${dadosExtraidos.nome}! Recebi suas informações. Um de nossos especialistas entrará em contato em breve para falar sobre seu projeto de "${dadosExtraidos.assunto}".`;
            await client.sendMessage(contato, msgFinal);
            delete conversas[contato];
        }

    } catch (error) {
        console.error("❌ Erro na comunicação com o Gemini:", error);
        conversas[contato].pop();
        await client.sendMessage(contato, "Desculpe, estou com um problema técnico no momento. Tente novamente mais tarde.");
    }
});

async function adicionarLeadNoCRM(dadosDoLead) {
    try {
        if (!crmUserId) {
            console.error("❌ ERRO CRÍTICO: A variável de ambiente CRM_USER_ID não está configurada!");
            return false;
        }
        const userDocRef = db.collection('userData').doc(crmUserId);
        const userDoc = await userDocRef.get();
        let leadsAtuais = userDoc.exists ? (userDoc.data().leads || []) : [];
        const novoLead = {
            id: leadsAtuais.length > 0 ? Math.max(...leadsAtuais.map(l => l.id)) + 1 : 0,
            nome: dadosDoLead.nome || "Não informado",
            whatsapp: dadosDoLead.whatsapp || "",
            origem: "WhatsApp Bot",
            status: "novo",
            qualificacao: "quente",
            notas: `[Lead criado via Bot]\nAssunto: ${dadosDoLead.assunto || "Não informado"}\nOrçamento: ${dadosDoLead.orcamento || "Não informado"}\nPrazo: ${dadosDoLead.prazo || "Não informado"}`,
            email: ""
        };
        leadsAtuais.push(novoLead);
        await userDocRef.set({ leads: leadsAtuais }, { merge: true });
        console.log(`✅ Lead "${novoLead.nome}" salvo com sucesso para o usuário ${crmUserId}!`);
        return true;
    } catch (error) {
        console.error("❌ Erro ao salvar lead no CRM:", error);
        return false;
    }
}

console.log("Iniciando o cliente WhatsApp...");
client.initialize();
