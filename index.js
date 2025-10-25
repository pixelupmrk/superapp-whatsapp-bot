// --- Funções Auxiliares do Baileys ---

async function handleNewMessage(message, userId) {
    const userContact = message.key.remoteJid;
    
    // --- CORREÇÃO CRÍTICA FINAL PARA O ERRO 'undefined' NO FIRESTORE ---
    let messageText = '';
    
    // Objeto message.message é onde está o tipo de conteúdo
    const content = message.message; 
    
    if (content) {
        // Tenta extrair texto de diferentes tipos de mensagens conhecidas
        messageText = content.conversation || 
                      content.extendedTextMessage?.text || 
                      content.imageMessage?.caption ||
                      content.videoMessage?.caption ||
                      content.documentMessage?.caption ||
                      ''; 
    }
    
    // Garante que o valor é SEMPRE uma String. Isso é o que faltou ser 100% à prova de falhas.
    messageText = String(messageText || '').trim(); 
    
    if (userContact === 'status@broadcast') {
        return; 
    }
    
    // Se a mensagem é vazia, mas não é um áudio ou mídia, a tratamos como Mídia Recebida
    if (messageText.length === 0 && content) {
        const isMedia = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage;
        if (isMedia) {
            messageText = 'Mídia Recebida (Sem Legenda)';
        } else if (content.stickerMessage) {
            messageText = 'Sticker/Figurinha Recebida';
        } else {
             // Se for uma mensagem de sistema ou outro tipo desconhecido, ignoramos.
             return; 
        }
    }


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
            
            // Lógica da IA para extrair nome 
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${messageText}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
            const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
            
            const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
            currentLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true, unreadCount: 0 }; 
            
            leads.push(currentLead);
        }
        
        // --- 2. LÓGICA CRÍTICA DE SALVAMENTO E NOTIFICAÇÃO ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
        
        // SALVA A MENSAGEM RECEBIDA DO CLIENTE (role: 'user')
        await chatRef.add({
            role: "user",
            parts: [{text: messageText}], 
            timestamp: FieldValue.serverTimestamp(),
        });
        
        // INCREMENTA O CONTADOR (Bolinha de Notificação)
        const leadIndex = leads.findIndex(l => l.id === currentLead.id);
        if (leadIndex !== -1) {
             leads[leadIndex].unreadCount = (leads[leadIndex].unreadCount || 0) + 1;
        }

        // --- 3. LÓGICA CONDICIONAL DE RESPOSTA DA IA ---
        let aiResponseText = ""; 
        
        if (currentLead.botActive === true) {
            
            console.log(`[Bot - ${userId}] Bot ativo. Gerando resposta para ${currentLead.nome}.`);
            
            // CHAMADA SIMPLES DA IA (Modo Conversação)
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo e focado em triagem e agendamento.";
            const fullPrompt = `${botInstructions}\n\nVocê está conversando com um cliente chamado ${currentLead.nome}. Mantenha a conversa natural, use negrito e emojis para destacar pontos-chave e tente fechar um agendamento ou follow-up.\n\nMensagem do cliente: "${messageText}"`;
            
            const aiResponseResult = await model.generateContent(fullPrompt);
            aiResponseText = aiResponseResult.text;
            
            // SALVA A RESPOSTA DA IA (role: 'model')
            await chatRef.add({
                role: "model",
                parts: [{text: aiResponseText}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Envia a resposta pelo WhatsApp (só se o Bot estiver ativo)
            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponseText });

        } else {
            console.log(`[Bot - ${userId}] Bot desativado para ${currentLead.nome}. Apenas salvando no histórico.`);
        }
        
        // 4. ATUALIZAÇÃO FINAL DO ARRAY DE LEADS NO FIRESTORE (Salva novo lead e/ou contador)
        await userDocRef.update({ leads: leads });
        
        // 5. NOTIFICA O FRONT-END PARA RECARREGAR A LISTA
        sendEventToUser(userId, { type: 'message', from: userContact });


    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro CRÍTICO ao processar mensagem:`, error);
        // Tenta salvar uma mensagem de erro no chat (para debug)
        await chatRef.add({
            role: "model",
            parts: [{text: "ERRO INTERNO: Falha ao processar a mensagem. Verifique os logs do Bot."}],
            timestamp: FieldValue.serverTimestamp(),
        });
    }
}
