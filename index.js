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
            team2Name: 'Team 2', 
            team2Score: 0 
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
            .addStringOption(option => 
                option.setName('team1').setDescription('Name for Team 1').setRequired(true))
            .addStringOption(option => 
                option.setName('team2').setDescription('Name for Team 2').setRequired(true)),
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
        // PERMISSION CHECKER
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
                content: `⚠️ **Missing Bot Permissions!**\nI cannot run the game properly because I am missing the following server permissions:\n${missingList}\n\nPlease update my role permissions in Server Settings and try again!`,
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
                content: `❌ **Hierarchy Error:** I couldn't assign the nickname or role to <@${describerUser.id}>. Make sure my bot role is dragged **above** 'THE GUIDE' role in your Server Settings!`,
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

        const embed = new EmbedBuilder()
            .setTitle('🚨 TABOO ROUND STARTED! 🚨')
            .setColor('#ff4757')
            .addFields(
                { name: 'Active Team', value: `${activeTeamName}`, inline: true },
                { name: 'Describer', value: `<@${describerUser.id}> (🧭 Joo Dee)`, inline: true },
                { name: 'Timer', value: `${timerSeconds} Seconds`, inline: true },
                { name: 'Points Config', value: `+${plusPoints} for correct | -${minusPoints} for taboo`, inline: false },
                { name: 'Target Word', value: `||${word.toUpperCase()}||`, inline: false },
                { name: 'Forbidden Words', value: tabooList.join(', '), inline: false },
                { name: 'Rules', value: `Max **3 descriptions**. Type **correct** when guessed or **incorrect** to pass.`, inline: false }
            );

        await interaction.reply({ embeds: [embed] });

        const timeout = setTimeout(async () => {
            const currentGame = activeGames.get(channelId);
            if (currentGame) {
                await cleanupDescriber(currentGame.guild, currentGame.member);
                activeGames.delete(channelId);
                const timeEmbed = new EmbedBuilder()
                    .setTitle('⏰ TIME IS UP!')
                    .setDescription(`Time ran out for **${activeTeamName}**! The word was **${word.toUpperCase()}**.`);
                await interaction.followUp({ embeds: [timeEmbed] });
            }
        }, timerSeconds * 1000);

        const currentGameToken = activeGames.get(channelId);
        if (currentGameToken) currentGameToken.timeoutHandle = timeout;

    } else if (commandName === 'scores') {
        const scoreEmbed = new EmbedBuilder()
            .setTitle('🏆 Current Scoreboard')
            .setColor('#2ed573')
            .addFields(
                { name: scores.team1Name, value: `${scores.team1Score} points`, inline: true },
                { name: scores.team2Name, value: `${scores.team2Score} points`, inline: true }
            );
        await interaction.reply({ embeds: [scoreEmbed] });

    } else if (commandName === 'resetscores') {
        scores.team1Score = 0;
        scores.team2Score = 0;
        await interaction.reply({ content: `🔄 Scores reset for **${scores.team1Name}** and **${scores.team2Name}**.` });
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const game = activeGames.get(channelId);
    if (!game) return;

    const contentLower = message.content.toLowerCase().trim();
    const scores = getGuildScores(message.guild.id);

    // 1. Correct Guess
    if (contentLower === 'correct') {
        clearTimeout(game.timeoutHandle);
        await cleanupDescriber(game.guild, game.member);
        activeGames.delete(channelId);

        if (game.team === 1) scores.team1Score += game.plusPoints;
        else scores.team2Score += game.plusPoints;

        const winEmbed = new EmbedBuilder()
            .setTitle('🎉 CORRECT GUESS!')
            .setColor('#2ed573')
            .setDescription(`**${game.activeTeamName}** guessed **${game.word.toUpperCase()}**! +${game.plusPoints} Points.`);

        return message.reply({ embeds: [winEmbed] });
    }

    // 2. Incorrect / Pass
    if (['incorrect', 'wrong', 'pass'].includes(contentLower)) {
        clearTimeout(game.timeoutHandle);
        await cleanupDescriber(game.guild, game.member);
        activeGames.delete(channelId);

        const failEmbed = new EmbedBuilder()
            .setTitle('❌ ROUND ENDED!')
            .setColor('#ff6b6b')
            .setDescription(`Round ended for **${game.activeTeamName}**. No points awarded.`);

        return message.reply({ embeds: [failEmbed] });
    }

    // 3. Describer Message Checks
    if (message.author.id === game.describerId) {

        // If describer tries typing after 3 messages, block them instantly and show warning
        if (game.descriptionsCount >= game.maxDescriptions) {
            await message.delete().catch(() => {});
            return message.channel.send(`Calm your horses Joo Dee. Your turn is over for now. <@${message.author.id}>`);
        }

        // Check for taboo words
        const violatedTaboo = game.taboos.find(taboo => contentLower.includes(taboo));

        if (violatedTaboo) {
            clearTimeout(game.timeoutHandle);
            await cleanupDescriber(game.guild, game.member);
            activeGames.delete(channelId);

            if (game.team === 1) scores.team1Score = Math.max(0, scores.team1Score - game.minusPoints);
            else scores.team2Score = Math.max(0, scores.team2Score - game.minusPoints);

            const tabooEmbed = new EmbedBuilder()
                .setTitle('❌ TABOO WORD VIOLATION!')
                .setColor('#ff4757')
                .setDescription(`<@${message.author.id}> said forbidden word **"${violatedTaboo}"**!`)
                .addFields({ name: 'Penalty', value: `**${game.activeTeamName}** loses ${game.minusPoints} point(s). Round over!` });

            return message.reply({ embeds: [tabooEmbed] });
        }

        // Increment description count and add checkmark
        game.descriptionsCount += 1;
        await message.react('✅').catch(() => {});
    }
});

client.login(process.env.DISCORD_TOKEN);
