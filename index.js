const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder,
    PermissionsBitField 
} = require('discord.js');

// --- BUILT-IN SELF-PING KEEP-ALIVE SERVER ---
const express = require('express');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Dai Li Taboo Bot is online and running 24/7! 🪨');
});

app.listen(PORT, () => {
    console.log(`Keep-alive web server active on port ${PORT}`);

    const targetUrl = process.env.RAILWAY_STATIC_URL 
        ? `http://${process.env.RAILWAY_STATIC_URL}` 
        : `http://localhost:${PORT}`;

    setInterval(() => {
        http.get(targetUrl, (res) => {
            console.log(`Internal heartbeat ping sent! Status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('Heartbeat ping failed:', err.message);
        });
    }, 4 * 60 * 1000);
});
// --------------------------------------------

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

function getGuildGame(guildId) {
    if (!guildScores.has(guildId)) {
        guildScores.set(guildId, { 
            gameStarted: false,
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
            .setName('taboo')
            .setDescription('Start a Taboo round (Requires active game session)')
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
            .addIntegerOption(option => option.setName('plus').setDescription('Points for correct').setRequired(false))
            .addIntegerOption(option => option.setName('minus').setDescription('Points deducted for taboo').setRequired(false)),
        new SlashCommandBuilder().setName('scores').setDescription('View scores'),
        new SlashCommandBuilder().setName('resetscores').setDescription('Reset scores / End game')
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

    // SECURITY CHECK: Only allow host user '0ladybunny'
    if (interaction.user.username !== '0ladybunny') {
        return interaction.reply({ 
            content: `⛔ **Access Denied:** Only the designated host (**0ladybunny**) is permitted to control the Dai Li game session.`, 
            ephemeral: true 
        });
    }

    const { commandName, guildId, channelId, guild } = interaction;
    const game = getGuildGame(guildId);

    if (commandName === 'taboo') {
        // CHECK IF GAME SESSION HAS BEEN STARTED VIA !startgame
        if (!game.gameStarted) {
            return interaction.reply({ 
                content: `⚠️ **No Active Game Session!** You must start a game first using the text command:\n\`!startgame [Team1Name], [Team2Name], [TotalRounds]\`\n*Example:* \`!startgame Red Team, Blue Team, 5\``, 
                ephemeral: true 
            });
        }

        if (game.currentRound >= game.totalRounds) {
            return interaction.reply({ 
                content: `🏁 **Match Completed!** All ${game.totalRounds} rounds have finished. Use \`/resetscores\` to start a new game!`, 
                ephemeral: true 
            });
        }

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
        
        game.currentRound += 1;
        const activeTeamName = teamNumber === 1 ? game.team1Name : game.team2Name;
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

        const publicEmbed = new EmbedBuilder()
            .setTitle(`🚨 TABOO ROUND ${game.currentRound}/${game.totalRounds} 🚨`)
            .setColor('#ff4757')
            .addFields(
                { name: 'Active Team', value: `${activeTeamName}`, inline: true },
                { name: 'Describer', value: `<@${describerUser.id}> (🧭 Joo Dee)`, inline: true },
                { name: 'Timer', value: `${timerSeconds} Seconds`, inline: true },
                { name: 'Points Config', value: `+${plusPoints} correct | -${minusPoints} taboo`, inline: false },
                { name: 'Status', value: `🔒 Secret word & taboo list whispered privately to <@${describerUser.id}>!`, inline: false },
                { name: 'Rules', value: `Max **3 descriptions**. Type **correct** when guessed or **incorrect** to pass.`, inline: false }
            );

        await interaction.reply({ embeds: [publicEmbed] });

        try {
            const secretEmbed = new EmbedBuilder()
                .setTitle('🤫 YOUR SECRET TABOO ASSIGNMENT')
                .setColor('#ffa502')
                .addFields(
                    { name: 'Target Word to Describe', value: `**${word.toUpperCase()}**`, inline: false },
                    { name: 'Forbidden (Taboo) Words', value: tabooList.join(', '), inline: false },
                    { name: 'Instructions', value: `You are **🧭 Joo Dee** for this round! Describe the target word without saying forbidden words. (Max 3 descriptions)`, inline: false }
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
            await interaction.followUp({ content: `<@${describerUser.id}>, DMs closed! Secret word:`, embeds: [fallbackEmbed], ephemeral: true });
        }

        const timeout = setTimeout(async () => {
            const currentGame = activeGames.get(channelId);
            if (currentGame) {
                await cleanupDescriber(currentGame.guild, currentGame.member);
                activeGames.delete(channelId);
                
                let roundText = `Time ran out for **${activeTeamName}**! The secret word was **${word.toUpperCase()}**.`;
                if (game.currentRound >= game.totalRounds) {
                    roundText += `\n\n🏁 **MATCH OVER!** Final Scores:\n🏆 **${game.team1Name}:** ${game.team1Score} pts\n🏆 **${game.team2Name}:** ${game.team2Score} pts`;
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
            .setTitle(`🏆 Current Scoreboard (Round ${game.currentRound}/${game.totalRounds})`)
            .setColor('#2ed573')
            .addFields(
                { name: game.team1Name, value: `${game.team1Score} points`, inline: true },
                { name: game.team2Name, value: `${game.team2Score} points`, inline: true }
            );
        await interaction.reply({ embeds: [scoreEmbed] });

    } else if (commandName === 'resetscores') {
        game.team1Score = 0;
        game.team2Score = 0;
        game.currentRound = 0;
        game.gameStarted = false;
        await interaction.reply({ content: `🔄 Game session ended, scores and round counters have been reset.` });
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const game = activeGames.get(channelId);
    const guildGame = getGuildGame(message.guild.id);
    const content = message.content;
    const contentLower = content.toLowerCase().trim();

    // --- HOST SECURITY CHECK FOR ADMIN TEXT COMMANDS ---
    const isHost = message.author.username === '0ladybunny';

    // --- START GAME COMMAND (Plain text) ---
    // Format: !startgame Team1Name, Team2Name, TotalRounds
    // Example: !startgame Red Team, Blue Team, 6
    if (contentLower.startsWith('!startgame')) {
        if (!isHost) {
            return message.reply('⛔ Only **0ladybunny** can start a game session.');
        }

        const args = content.replace('!startgame', '').trim().split(',');
        if (args.length < 3) {
            return message.reply('⚠️ Invalid format! Use: `!startgame [Team1Name], [Team2Name], [TotalRounds]`\n*Example:* `!startgame Team Alpha, Team Beta, 5`');
        }

        guildGame.team1Name = args[0].trim();
        guildGame.team2Name = args[1].trim();
        const roundsInput = parseInt(args[2].trim());

        if (isNaN(roundsInput) || roundsInput < 5 || roundsInput > 10) {
            return message.reply('⚠️ Total rounds must be a number between **5 and 10**!');
        }

        guildGame.totalRounds = roundsInput;
        guildGame.currentRound = 0;
        guildGame.team1Score = 0;
        guildGame.team2Score = 0;
        guildGame.gameStarted = true;

        const startEmbed = new EmbedBuilder()
            .setTitle('🪨 DAI LI TABOO GAME STARTED! 🪨')
            .setColor('#70a1ff')
            .setDescription(`A new game session has been initialized by host **0ladybunny**!`)
            .addFields(
                { name: 'Team 1', value: guildGame.team1Name, inline: true },
                { name: 'Team 2', value: guildGame.team2Name, inline: true },
                { name: 'Total Rounds', value: `${guildGame.totalRounds} Rounds`, inline: false },
                { name: 'Next Step', value: `You can now use \`/taboo\` to begin Round 1!`, inline: false }
            );
        return message.reply({ embeds: [startEmbed] });
    }

    // --- DAI LI INTRO TRIGGER ---
    if (content.includes('DAI LI')) {
        const daiLiIntro = `# 🪨 BY ORDER OF THE DAI LI 🪨

**ATTENTION, CITIZENS.** *Yes, you. Especially you.*

Welcome to the **Taboo Division** of the Dai Li. I am your Agent, your host, and your *only* friend. And I will be overseeing today’s game.

Please remain calm. Everything here is *perfectly* orderly.

> ## 📜 THE LAWS OF TABOO 📜

**Law #1:** The **Describer** receives the *secret word* and the *forbidden words*. They are now the most important person in the realm. Do not let it go to their head though👀.

**Law #2:** The Describer must make the guessers say the secret word **WITHOUT** speaking a single forbidden word.

**Law #3:** Guessers must guess the word. Quickly. The Dai Li is **very busy** and has a tight schedule of *surveillance*.

**Law #4:** Say a forbidden word, and I will know. **I always know.** You will be escorted to a lovely, peaceful location with *no windows and no exit.* Do not ask questions. The questions are also forbidden.

GOT IT? GET IN LINE NOW.

> ## 🏆 VICTORY & DEFEAT 🏆

**Win?** *Excellent.* The Dai Li is **very proud** of you. This will be noted in your file.

**Lose?** *Also noted.* In your file. It is a LARGE file.

**Complain?** There is **no** complaints department. There is only **ME.** 👁️

There is no cheating in my city. There is no confusion. There is no lag. *(If there is lag, it is the fault of the Fire Nation.)*

**All hail the Dai Li. All hail Taboo.**
*Now go. Describe. Guess. Obey.* 🪨`;

        return message.reply({
            content: daiLiIntro,
            files: ['./daili.gif']
        }).catch(() => {
            return message.reply(daiLiIntro);
        });
    }

    // --- TEAM & ROSTER COMMANDS ---
    if (contentLower.startsWith('!team1')) {
        if (!isHost) return message.reply('⛔ Only **0ladybunny** can manage team rosters.');
        const mentions = message.mentions.users;
        if (mentions.size === 0) return message.reply('⚠️ Please mention members for Team 1! Example: `!team1 @User`');
        mentions.forEach(u => {
            guildGame.team1Members.add(u.id);
            guildGame.team2Members.delete(u.id);
        });
        const teamList = Array.from(guildGame.team1Members).map(id => `<@${id}>`).join(', ');
        return message.reply(`✅ **${guildGame.team1Name}** members: ${teamList}`);
    }

    if (contentLower.startsWith('!team2')) {
        if (!isHost) return message.reply('⛔ Only **0ladybunny** can manage team rosters.');
        const mentions = message.mentions.users;
        if (mentions.size === 0) return message.reply('⚠️ Please mention members for Team 2! Example: `!team2 @User`');
        mentions.forEach(u => {
            guildGame.team2Members.add(u.id);
            guildGame.team1Members.delete(u.id);
        });
        const teamList = Array.from(guildGame.team2Members).map(id => `<@${id}>`).join(', ');
        return message.reply(`✅ **${guildGame.team2Name}** members: ${teamList}`);
    }

    if (contentLower.startsWith('!swap')) {
        if (!isHost) return message.reply('⛔ Only **0ladybunny** can swap team members.');
        const userToSwap = message.mentions.users.first();
        if (!userToSwap) return message.reply('⚠️ Please mention a user to swap! Example: `!swap @User`');
        
        const userId = userToSwap.id;
        let movedTo = '';

        if (guildGame.team1Members.has(userId)) {
            guildGame.team1Members.delete(userId);
            guildGame.team2Members.add(userId);
            movedTo = guildGame.team2Name;
        } else {
            guildGame.team2Members.delete(userId);
            guildGame.team1Members.add(userId);
            movedTo = guildGame.team1Name;
        }
        return message.reply(`🔄 Swapped <@${userId}> over to **${movedTo}**!`);
    }

    if (contentLower === '!teams') {
        const t1List = Array.from(guildGame.team1Members).map(id => `<@${id}>`).join(', ') || 'None';
        const t2List = Array.from(guildGame.team2Members).map(id => `<@${id}>`).join(', ') || 'None';

        const embed = new EmbedBuilder()
            .setTitle('👥 Team Rosters')
            .setColor('#70a1ff')
            .addFields(
                { name: guildGame.team1Name, value: t1List, inline: true },
                { name: guildGame.team2Name, value: t2List, inline: true }
            );
        return message.reply({ embeds: [embed] });
    }

    if (!game) return;

    async function handleRoundEnd(winEmbed) {
        clearTimeout(game.timeoutHandle);
        await cleanupDescriber(game.guild, game.member);
        activeGames.delete(channelId);

        let finalMsg = winEmbed;
        if (guildGame.currentRound >= guildGame.totalRounds) {
            finalMsg.addFields({ 
                name: '🏁 MATCH OVER!', 
                value: `Final Scores:\n🏆 **${guildGame.team1Name}:** ${guildGame.team1Score} pts\n🏆 **${guildGame.team2Name}:** ${guildGame.team2Score} pts` 
            });
        }
        return message.reply({ embeds: [finalMsg] });
    }

    if (contentLower === 'correct') {
        if (game.team === 1) guildGame.team1Score += game.plusPoints;
        else guildGame.team2Score += game.plusPoints;

        const winEmbed = new EmbedBuilder()
            .setTitle(`🎉 CORRECT GUESS! (Round ${guildGame.currentRound}/${guildGame.totalRounds})`)
            .setColor('#2ed573')
            .setDescription(`**${game.activeTeamName}** guessed **${game.word.toUpperCase()}**! +${game.plusPoints} Points.`);

        return handleRoundEnd(winEmbed);
    }

    if (['incorrect', 'wrong', 'pass'].includes(contentLower)) {
        const failEmbed = new EmbedBuilder()
            .setTitle(`❌ ROUND ENDED! (Round ${guildGame.currentRound}/${guildGame.totalRounds})`)
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
            if (game.team === 1) guildGame.team1Score = Math.max(0, guildGame.team1Score - game.minusPoints);
            else guildGame.team2Score = Math.max(0, guildGame.team2Score - game.minusPoints);

            const tabooEmbed = new EmbedBuilder()
                .setTitle(`❌ TABOO VIOLATION! (Round ${guildGame.currentRound}/${guildGame.totalRounds})`)
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
