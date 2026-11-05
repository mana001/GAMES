const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder,
    PermissionsBitField 
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const activeGames = new Map();
const guildScores = new Map();

function getGuildScores(guildId) {
    if (!guildScores.has(guildId)) {
        guildScores.set(guildId, { 
            team1Name: 'Team 1', 
            team1Score: 0, 
            team1Members: new Set(),
            team2Name: 'Team 2', 
            team2Score: 0,
            team2Members: new Set(),
            totalRounds: 5,
            currentRound: 0
        });
    }
    return guildScores.get(guildId);
}

async function cleanupDescriber(guild, member) {
    if (!member) return;
    try {
        await member.setNickname(null).catch(() => {});
        const role = guild.roles.cache.find(r => r.name === 'THE GUIDE');
        if (role && member.roles.cache.has(role.id)) {
            await member.roles.remove(role).catch(() => {});
        }
    } catch (err) {
        console.error('Error cleaning up describer roles/nickname:', err);
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const commands = [
        new SlashCommandBuilder()
            .setName('setteams')
            .setDescription('Set custom names for Team 1 and Team 2')
            .addStringOption(option => option.setName('team1').setDescription('Name for Team 1').setRequired(true))
            .addStringOption(option => option.setName('team2').setDescription('Name for Team 2').setRequired(true)),
        new SlashCommandBuilder()
            .setName('taboo')
            .setDescription('Start a Taboo round')
            .addStringOption(option => option.setName('word').setDescription('Target word').setRequired(true))
            .addStringOption(option => option.setName('taboos').setDescription('Taboo words separated by commas').setRequired(true))
            .addIntegerOption(option => 
                option.setName('timer').setDescription('Timer duration').setRequired(true)
                    .addChoices(
                        { name: '30 Seconds', value: 30 },
                        { name: '40 Seconds', value: 40 },
                        { name: '60 Seconds', value: 60 },
                        { name: '90 Seconds', value: 90 }
                    ))
            .addUserOption(option => option.setName('describer').setDescription('Player describing').setRequired(true))
            .addIntegerOption(option => 
                option.setName('team').setDescription('Team playing').setRequired(true)
                    .addChoices({ name: 'Team 1', value: 1 }, { name: 'Team 2', value: 2 }))
            .addIntegerOption(option => 
                option.setName('rounds').setDescription('Total rounds for the match (5-10)').setRequired(true)
                    .addChoices(
                        { name: '5 Rounds', value: 5 },
                        { name: '6 Rounds', value: 6 },
                        { name: '7 Rounds', value: 7 },
                        { name: '8 Rounds', value: 8 },
                        { name: '9 Rounds', value: 9 },
                        { name: '10 Rounds', value: 10 }
                    ))
            .addStringOption(option => option.setName('team1_name').setDescription('Override Team 1').setRequired(false))
            .addStringOption(option => option.setName('team2_name').setDescription('Override Team 2').setRequired(false))
            .addIntegerOption(option => option.setName('plus').setDescription('Points for correct').setRequired(false))
            .addIntegerOption(option => option.setName('minus').setDescription('Points deducted for taboo').setRequired(false)),
        new SlashCommandBuilder().setName('scores').setDescription('View scores'),
        new SlashCommandBuilder().setName('resetscores').setDescription('Reset scores')
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded slash commands.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, channelId, guild } = interaction;
    const scores = getGuildScores(guildId);

    if (commandName === 'setteams') {
        const t1 = interaction.options.getString('team1').trim();
        const t2 = interaction.options.getString('team2').trim();
        scores.team1Name = t1;
        scores.team2Name = t2;

        const embed = new EmbedBuilder()
            .setTitle('⚙️ Teams Configured!')
            .setColor('#70a1ff')
            .setDescription(`**Team 1:** ${t1}\n**Team 2:** ${t2}`);
        return interaction.reply({ embeds: [embed] });

    } else if (commandName === 'taboo') {
        const botMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id);
        const requiredPerms = [
            { perm: PermissionsBitField.Flags.ManageNicknames, name: 'Manage Nicknames' },
            { perm: PermissionsBitField.Flags.ManageRoles, name: 'Manage Roles' },
            { perm: PermissionsBitField.Flags.ManageMessages, name: 'Manage Messages' },
            { perm: PermissionsBitField.Flags.AddReactions, name: 'Add Reactions' }
        ];

        const missing = requiredPerms.filter(p => !botMember.permissions.has(p.perm));
        if (missing.length > 0) {
            const missingList = missing.map(m => `• **${m.name}**`).join('\n');
            return interaction.reply({
                content: `⚠️ **Missing Bot Permissions!**\nI am missing: \n${missingList}\nPlease update my role permissions!`,
                ephemeral: true
            });
        }

        if (activeGames.has(channelId)) {
            return interaction.reply({ content: '⚠️ A round is already active in this channel!', ephemeral: true });
        }

        const word = interaction.options.getString('word').trim().toLowerCase();
        const rawTaboos = interaction.options.getString('taboos');
        const tabooList = rawTaboos.split(',').map(t => t.trim().toLowerCase());
        const timerSeconds = interaction.options.getInteger('timer');
        const describerUser = interaction.options.getUser('describer');
        const teamNumber = interaction.options.getInteger('team');
        const selectedRounds = interaction.options.getInteger('rounds');
        
        scores.totalRounds = selectedRounds;
        scores.currentRound += 1;

        const team1NameInput = interaction.options.getString('team1_name');
        const team2NameInput = interaction.options.getString('team2_name');
        if (team1NameInput) scores.team1Name = team1NameInput.trim();
        if (team2NameInput) scores.team2Name = team2NameInput.trim();

        const activeTeamName = teamNumber === 1 ? scores.team1Name : scores.team2Name;
        const plusPoints = interaction.options.getInteger('plus') ?? 1;
        const minusPoints = interaction.options.getInteger('minus') ?? 1;

        let member;
        try {
            member = await guild.members.fetch(describerUser.id);
            await member.setNickname('🧭 Joo Dee');
            
            let guideRole = guild.roles.cache.find(r => r.name === 'THE GUIDE');
            if (!guideRole) {
                guideRole = await guild.roles.create({ name: 'THE GUIDE', color: '#ff4757', reason: 'Taboo Bot Role' });
            }
            await member.roles.add(guideRole);
        } catch (err) {
            console.error('Role/Nickname assignment error:', err);
            return interaction.reply({
                content: `❌ **Hierarchy Error:** I couldn't assign nickname/role to <@${describerUser.id}>. Make sure my bot role is above 'THE GUIDE' and target user isn't the owner!`,
                ephemeral: true
            });
        }

        activeGames.set(channelId, {
            word,
            taboos: tabooList,
            describerId: describerUser.id,
            team: teamNumber,
            activeTeamName,
            descriptionsCount: 0,
            maxDescriptions: 3,
            timer: timerSeconds,
            plusPoints,
            minusPoints,
            guild,
            member
        });

        // Public Game Card (Hides secret word & taboos)
        const publicEmbed = new EmbedBuilder()
            .setTitle(`🚨 TABOO ROUND ${scores.currentRound}/${scores.totalRounds} 🚨`)
            .setColor('#ff4757')
            .addFields(
                { name: 'Active Team', value: `${activeTeamName}`, inline: true },
                { name: 'Describer', value: `<@${describerUser.id}> (🧭 Joo Dee)`, inline: true },
                { name: 'Timer', value: `${timerSeconds} Seconds`, inline: true },
                { name: 'Points Config', value: `+${plusPoints} correct | -${minusPoints} taboo`, inline: false },
                { name: 'Status', value: `🔒 Secret word & taboo list have been whispered privately to <@${describerUser.id}>!`, inline: false },
                { name: 'Rules', value: `Max **3 descriptions**. Type **correct** when guessed or **incorrect** to pass.`, inline: false }
            );

        await interaction.reply({ embeds: [publicEmbed] });

        // Whisper Secret Assignment to Describer
        try {
            const secretEmbed = new EmbedBuilder()
                .setTitle('🤫 YOUR SECRET TABOO ASSIGNMENT')
                .setColor('#ffa502')
                .addFields(
                    { name: 'Target Word to Describe', value: `**${word.toUpperCase()}**`, inline: false },
                    { name: 'Forbidden (Taboo) Words', value: tabooList.join(', '), inline: false },
                    { name: 'Instructions', value: `You are **🧭 Joo Dee** for this round! Describe the target word to your team without saying any of the forbidden words. You have **3 descriptions** max!`, inline: false }
                );
            await describerUser.send({ embeds: [secretEmbed] });
        } catch (dmErr) {
            const fallbackEmbed = new EmbedBuilder()
                .setTitle('🤫 YOUR SECRET TABOO ASSIGNMENT')
                .setColor('#ffa502')
                .addFields(
                    { name: 'Target Word', value: `**${word.toUpperCase()}**`, inline: false },
                    { name: 'Forbidden Words', value: tabooList.join(', '), inline: false }
                );
            await interaction.followUp({ content: `<@${describerUser.id}>, I couldn't DM you (DMs closed)! Here is your secret word:`, embeds: [fallbackEmbed], ephemeral: true });
        }

        const timeout = setTimeout(async () => {
            const currentGame = activeGames.get(channelId);
            if (currentGame) {
                await cleanupDescriber(currentGame.guild, currentGame.member);
                activeGames.delete(channelId);
                
                let roundText = `Time ran out for **${activeTeamName}**! The secret word was **${word.toUpperCase()}**.`;
                if (scores.currentRound >= scores.totalRounds) {
                    roundText += `\n\n🏁 **MATCH OVER!** Final Scores:\n🏆 **${scores.team1Name}:** ${scores.team1Score} pts\n🏆 **${scores.team2Name}:** ${scores.team2Score} pts`;
                }

                const timeEmbed = new EmbedBuilder()
                    .setTitle('⏰ TIME IS UP!')
                    .setDescription(roundText);
                await interaction.followUp({ embeds: [timeEmbed] });
            }
        }, timerSeconds * 1000);

        const currentGameToken = activeGames.get(channelId);
        if (currentGameToken) currentGameToken.timeoutHandle = timeout;

    } else if (commandName === 'scores') {
        const scoreEmbed = new EmbedBuilder()
            .setTitle(`🏆 Current Scoreboard (Round ${scores.currentRound}/${scores.totalRounds})`)
            .setColor('#2ed573')
            .addFields(
                { name: scores.team1Name, value: `${scores.team1Score} points`, inline: true },
                { name: scores.team2Name, value: `${scores.team2Score} points`, inline: true }
            );
        await interaction.reply({ embeds: [scoreEmbed] });

    } else if (commandName === 'resetscores') {
        scores.team1Score = 0;
        scores.team2Score = 0;
        scores.currentRound = 0;
        await interaction.reply({ content: `🔄 Scores and round counters have been reset.` });
    }
});

// Plain Text Message Handler
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const game = activeGames.get(channelId);
    const scores = getGuildScores(message.guild.id);
    const content = message.content;
    const contentLower = content.toLowerCase().trim();

    // --- DAI LI INTRO TRIGGER (Requires "DAI LI" in uppercase anywhere in sentence) ---
    if (content.includes('DAI LI')) {
        const daiLiIntro = `🪨 ATTENTION, CITIZEN. 🪨
Welcome to the Taboo Division of the Dai Li.
I am your agent, and I will be overseeing today’s game. Please remain calm. Everything here is perfectly orderly.
Your mission, should you choose to accept it:

Describe the secret word to your teammates. But beware: certain words are forbidden. Say one, and I will know.
Rules of the Realm:

🔒 The Describer sees the secret word and the forbidden words.

🗣️ The Describer must give clues without speaking any forbidden word.

🕵️ Guessers, work together to uncover the secret word.

⚠️ Say a forbidden word, and you will be reported to the authorities. You will be taken to a very nice place. Do not ask where.
There is no cheating in this game. There is no confusion. There is only Taboo.
The Dai Li is always watching. Good luck, citizens. 🪨`;

        return message.reply({
            content: daiLiIntro,
            files: ['./daili.gif']
        }).catch(() => {
            // Fallback if gif file is missing
            return message.reply(daiLiIntro);
        });
    }

    // --- TEAM & ROSTER COMMANDS (NO SLASHES) ---

    if (contentLower.startsWith('!team1')) {
        const mentions = message.mentions.users;
        if (mentions.size === 0) return message.reply('⚠️ Please mention members to add to Team 1! Example: `!team1 @User`');
        mentions.forEach(u => {
            scores.team1Members.add(u.id);
            scores.team2Members.delete(u.id);
        });
        const teamList = Array.from(scores.team1Members).map(id => `<@${id}>`).join(', ');
        return message.reply(`✅ **${scores.team1Name}** members: ${teamList}`);
    }

    if (contentLower.startsWith('!team2')) {
        const mentions = message.mentions.users;
        if (mentions.size === 0) return message.reply('⚠️ Please mention members to add to Team 2! Example: `!team2 @User`');
        mentions.forEach(u => {
            scores.team2Members.add(u.id);
            scores.team1Members.delete(u.id);
        });
        const teamList = Array.from(scores.team2Members).map(id => `<@${id}>`).join(', ');
        return message.reply(`✅ **${scores.team2Name}** members: ${teamList}`);
    }

    if (contentLower.startsWith('!swap')) {
        const userToSwap = message.mentions.users.first();
        if (!userToSwap) return message.reply('⚠️ Please mention a user to swap! Example: `!swap @User`');
        
        const userId = userToSwap.id;
        let movedTo = '';

        if (scores.team1Members.has(userId)) {
            scores.team1Members.delete(userId);
            scores.team2Members.add(userId);
            movedTo = scores.team2Name;
        } else {
            scores.team2Members.delete(userId);
            scores.team1Members.add(userId);
            movedTo = scores.team1Name;
        }
        return message.reply(`🔄 Swapped <@${userId}> over to **${movedTo}**!`);
    }

    if (contentLower === '!teams') {
        const t1List = Array.from(scores.team1Members).map(id => `<@${id}>`).join(', ') || 'None';
        const t2List = Array.from(scores.team2Members).map(id => `<@${id}>`).join(', ') || 'None';

        const embed = new EmbedBuilder()
            .setTitle('👥 Team Rosters')
            .setColor('#70a1ff')
            .addFields(
                { name: scores.team1Name, value: t1List, inline: true },
                { name: scores.team2Name, value: t2List, inline: true }
            );
        return message.reply({ embeds: [embed] });
    }

    // --- GAME CONTROLS ---

    if (!game) return;

    async function handleRoundEnd(winEmbed) {
        clearTimeout(game.timeoutHandle);
        await cleanupDescriber(game.guild, game.member);
        activeGames.delete(channelId);

        let finalMsg = winEmbed;
        if (scores.currentRound >= scores.totalRounds) {
            finalMsg.addFields({ 
                name: '🏁 MATCH OVER!', 
                value: `Final Scores:\n🏆 **${scores.team1Name}:** ${scores.team1Score} pts\n🏆 **${scores.team2Name}:** ${scores.team2Score} pts` 
            });
        }
        return message.reply({ embeds: [finalMsg] });
    }

    if (contentLower === 'correct') {
        if (game.team === 1) scores.team1Score += game.plusPoints;
        else scores.team2Score += game.plusPoints;

        const winEmbed = new EmbedBuilder()
            .setTitle(`🎉 CORRECT GUESS! (Round ${scores.currentRound}/${scores.totalRounds})`)
            .setColor('#2ed573')
            .setDescription(`**${game.activeTeamName}** guessed **${game.word.toUpperCase()}**! +${game.plusPoints} Points.`);

        return handleRoundEnd(winEmbed);
    }

    if (['incorrect', 'wrong', 'pass'].includes(contentLower)) {
        const failEmbed = new EmbedBuilder()
            .setTitle(`❌ ROUND ENDED! (Round ${scores.currentRound}/${scores.totalRounds})`)
            .setColor('#ff6b6b')
            .setDescription(`Round ended for **${game.activeTeamName}**. The secret word was **${game.word.toUpperCase()}**. No points awarded.`);

        return handleRoundEnd(failEmbed);
    }

    if (message.author.id === game.describerId) {
        if (game.descriptionsCount >= game.maxDescriptions) {
            await message.delete().catch(() => {});
            return message.channel.send(`Calm your horses Joo Dee. Your turn is over for now. <@${message.author.id}>`);
        }

        const violatedTaboo = game.taboos.find(taboo => contentLower.includes(taboo));

        if (violatedTaboo) {
            if (game.team === 1) scores.team1Score = Math.max(0, scores.team1Score - game.minusPoints);
            else scores.team2Score = Math.max(0, scores.team2Score - game.minusPoints);

            const tabooEmbed = new EmbedBuilder()
                .setTitle(`❌ TABOO VIOLATION! (Round ${scores.currentRound}/${scores.totalRounds})`)
                .setColor('#ff4757')
                .setDescription(`<@${message.author.id}> said forbidden word **"${violatedTaboo}"**!`)
                .addFields({ name: 'Penalty', value: `**${game.activeTeamName}** loses ${game.minusPoints} point(s). Round over!` });

            return handleRoundEnd(tabooEmbed);
        }

        game.descriptionsCount += 1;
        await message.react('✅').catch(() => {});
    }
});

client.login(process.env.DISCORD_TOKEN);
