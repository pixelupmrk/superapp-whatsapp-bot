// === DEPENDÊNCIAS ===
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// === CONFIGURAÇÕES ===
console.log('Lendo variáveis de ambiente...');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
const geminiApiKey = process.env.GEMINI_API_KEY;
console.log('Variáveis lidas com sucesso.');

// Inicializa Firebase
try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${firebaseConfig.projectId}.firebaseio.com`
    });
    console.log('✅ Conectado ao Firebase!');
} catch (error) {
    console.error('❌ ERRO AO CONECTAR COM FIREBASE:', error);
}


// Inicializa Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
console.log('✅ Conectado à API do Gemini!');

// === BOT DO WHATSAPP ===
const client = new Client();
let qrCodeGerado = false; // Flag para controlar o QR Code

client.on('qr', qr => {
    if (qrCodeGerado) return; // Se já gerou, não faz nada
    qrCodeGerado = true; // Marca que o QR Code foi gerado

    console.log("--------------------------------------------------");
    console.log("LEIA O QR CODE ABAIXO COM SEU CELULAR:");
    qrcode.generate(qr, { small: true });
    console.log("--------------------------------------------------");
});

client.on('ready', () => {
    console.log('✅ Cliente WhatsApp conectado e pronto para trabalhar!');
    qrCodeGerado = false; // Reseta a flag para o caso de precisar reconectar
});

client.on('disconnected', (reason) => {
    console.log('❌ Cliente foi desconectado!', reason);
    qrCodeGerado = false; // Permite gerar um novo QR Code na próxima tentativa
    // A Render irá reiniciar o processo automaticamente se ele falhar.
});

// Armazena o histórico das conversas em memória
const conversas = {};

const PROMPT_ASSISTENTE = `
Você é um assistente virtual para a PixelUp. Sua função é fazer o pré-atendimento de novos clientes via WhatsApp.
Seu objetivo é extrair 4 informações: NOME, ASSUNTO, ORÇAMENTO e PRAZO.
Siga estas regras estritamente:
1. Seja sempre cordial e prestativo.
2. Faça uma pergunta de cada vez para não confundir o cliente.
3. Quando você tiver todas as 4 informações, finalize a conversa agradecendo e dizendo que um especialista entrará em contato em breve.
4. Após finalizar, sua resposta DEVE SER APENAS um objeto JSON válido, sem nenhum texto adicional antes ou depois. O JSON deve ter a seguinte estrutura:
   {
     "finalizado": true,
     "nome": "Nome do Cliente",
     "assunto": "Assunto ou serviço desejado",
     "orcamento": "Valor ou faixa de orçamento",
     "prazo": "Prazo desejado"
   }
5. Se você ainda não tem todas as informações, apenas continue a conversa normalmente. NÃO retorne um JSON.
`;

client.on('message', async message => {
    const contato = message.from;
    const textoRecebido = message.body;

    console.log(`Mensagem de ${contato}: "${textoRecebido}"`);
    if (message.isGroup) return;

    if (!conversas[contato]) {
        conversas[contato] = [
            { role: "user", parts: [{ text: PROMPT_ASSISTENTE }] },
            { role: "model", parts: [{ text: "Ok, entendi minhas instruções. Estou pronto para começar." }] }
        ];
    }
    
    conversas[contato].push({ role: "user", parts: [{ text: textoRecebido }] });

    try {
        const chat = geminiModel.startChat({ history: conversas[contato] });
        const result = await chat.sendMessage(textoRecebido);
        const respostaIA = result.response.text();
        console.log(`Resposta da IA: "${respostaIA}"`);

        try {
            const dadosExtraidos = JSON.parse(respostaIA);
            if (dadosExtraidos.finalizado === true) {
                console.log("Conversa finalizada. Tentando salvar no CRM...");
                dadosExtraidos.whatsapp = contato.replace('@c.us', '');
                
                await adicionarLeadNoCRM(dadosExtraidos);
                
                const msgFinal = `Obrigado, ${dadosExtraidos.nome}! Recebi suas informações. Um de nossos especialistas entrará em contato em breve para falar sobre seu projeto de "${dadosExtraidos.assunto}".`;
                await client.sendMessage(contato, msgFinal);

                delete conversas[contato];
                return;
            }
        } catch (e) {
            await client.sendMessage(contato, respostaIA);
            conversas[contato].push({ role: "model", parts: [{ text: respostaIA }] });
        }

    } catch (error) {
        console.error("❌ Erro na comunicação com o Gemini:", error);
        await client.sendMessage(contato, "Desculpe, estou com um problema técnico no momento. Tente novamente mais tarde.");
    }
});

async function adicionarLeadNoCRM(dadosDoLead) {
    try {
        const userId = "bSqhMhT6o6Zg0u3bCMT2w5i7c8C2"; // <--- LEMBRE-SE DE VERIFICAR SE ESTE UID ESTÁ CORRETO
        if (!userId) throw new Error("UID do usuário não definido!");

        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();

        let leadsAtuais = [];
        if (userDoc.exists) {
            leadsAtuais = userDoc.data().leads || [];
        }
        
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
        console.log(`✅ Lead "${novoLead.nome}" salvo com sucesso no CRM!`);
        return true;
    } catch (error) {
        console.error("❌ Erro ao salvar lead no CRM:", error);
        return false;
    }
}

console.log("Iniciando o cliente WhatsApp...");
client.initialize();
