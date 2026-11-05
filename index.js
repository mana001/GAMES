const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder 
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Store active game states per channel: channelId -> game object
const activeGames = new Map();

// Store team scores per guild: guildId -> { team1Name, team1Score, team2Name, team2Score }
const guildScores = new Map();

// Helper function to initialize or get scores structure
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

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Register Slash Commands
    const commands = [
        new SlashCommandBuilder()
            .setName('setteams')
            .setDescription('Set custom names for Team 1 and Team 2')
            .addStringOption(option => 
                option.setName('team1')
                    .setDescription('Name for Team 1 (e.g., Red Dragons)')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('team2')
                    .setDescription('Name for Team 2 (e.g., Blue Phoenixes)')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('taboo')
            .setDescription('Start a Taboo round')
            .addStringOption(option => 
                option.setName('word')
                    .setDescription('The target word to guess (e.g., Pizza)')
                    .setRequired(true))
            .addStringOption(option => 
                option.setName('taboos')
                    .setDescription('Taboo words separated by commas (e.g., Italian, slices, triangle)')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('timer')
                    .setDescription('Timer duration in seconds')
                    .setRequired(true)
                    .addChoices(
                        { name: '30 Seconds', value: 30 },
                        { name: '40 Seconds', value: 40 },
                        { name: '60 Seconds', value: 60 },
                        { name: '90 Seconds', value: 90 }
                    ))
            .addUserOption(option => 
                option.setName('describer')
                    .setDescription('The player describing the word')
                    .setRequired(true))
            .addIntegerOption(option => 
                option.setName('team')
                    .setDescription('Which team is playing right now?')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Team 1', value: 1 },
                        { name: 'Team 2', value: 2 }
                    ))
            .addStringOption(option => 
                option.setName('team1_name')
                    .setDescription('Optional: Override name for Team 1')
                    .setRequired(false))
            .addStringOption(option => 
                option.setName('team2_name')
                    .setDescription('Optional: Override name for Team 2')
                    .setRequired(false))
            .addIntegerOption(option => 
                option.setName('plus')
                    .setDescription('Points awarded for a correct guess (Default: 1)')
                    .setRequired(false))
            .addIntegerOption(option => 
                option.setName('minus')
                    .setDescription('Points deducted for a taboo violation (Default: 1)')
                    .setRequired(false)),
        new SlashCommandBuilder()
            .setName('scores')
            .setDescription('View current team scores'),
        new SlashCommandBuilder()
            .setName('resetscores')
            .setDescription('Reset scores for both teams')
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// Handle Slash Commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, channelId } = interaction;
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
        if (activeGames.has(channelId)) {
            return interaction.reply({ content: '⚠️ A round is already active in this channel!', ephemeral: true });
        }

        const word = interaction.options.getString('word').trim().toLowerCase();
        const rawTaboos = interaction.options.getString('taboos');
        const tabooList = rawTaboos.split(',').map(t => t.trim().toLowerCase());
        const timerSeconds = interaction.options.getInteger('timer');
        const describer = interaction.options.getUser('describer');
        const teamNumber = interaction.options.getInteger('team');
        
        // Custom team names if provided in the command, otherwise use saved names
        const team1NameInput = interaction.options.getString('team1_name');
        const team2NameInput = interaction.options.getString('team2_name');

        if (team1NameInput) scores.team1Name = team1NameInput.trim();
        if (team2NameInput) scores.team2Name = team2NameInput.trim();

        const activeTeamName = teamNumber === 1 ? scores.team1Name : scores.team2Name;

        // Custom plus/minus values or fallback to 1
        const plusPoints = interaction.options.getInteger('plus') ?? 1;
        const minusPoints = interaction.options.getInteger('minus') ?? 1;

        // Set game state
        activeGames.set(channelId, {
            word: word,
            taboos: tabooList,
            describerId: describer.id,
            team: teamNumber,
            activeTeamName: activeTeamName,
            descriptionsCount: 0,
            maxDescriptions: 3,
            timer: timerSeconds,
            plusPoints: plusPoints,
            minusPoints: minusPoints
        });

        const embed = new EmbedBuilder()
            .setTitle('🚨 TABOO ROUND STARTED! 🚨')
            .setColor('#ff4757')
            .addFields(
                { name: 'Active Team', value: `${activeTeamName}`, inline: true },
                { name: 'Describer', value: `<@${describer.id}>`, inline: true },
                { name: 'Timer', value: `${timerSeconds} Seconds`, inline: true },
                { name: 'Points Config', value: `+${plusPoints} for correct | -${minusPoints} for taboo`, inline: false },
                { name: 'Target Word', value: `||${word.toUpperCase()}||`, inline: false },
                { name: 'Forbidden (Taboo) Words', value: tabooList.join(', '), inline: false },
                { name: 'Controls', value: `Describer gets **3 descriptions** max.\nType **correct** for a win | Type **incorrect** to end turn with no points.`, inline: false }
            )
            .setFooter({ text: 'Describer, type your descriptions in chat.' });

        await interaction.reply({ embeds: [embed] });

        // Set Round Timer
        const timeout = setTimeout(async () => {
            if (activeGames.has(channelId)) {
                activeGames.delete(channelId);
                const timeEmbed = new EmbedBuilder()
                    .setTitle('⏰ TIME IS UP!')
                    .setDescription(`Time ran out for **${activeTeamName}**! The word was **${word.toUpperCase()}**.`);
                await interaction.followUp({ embeds: [timeEmbed] });
            }
        }, timerSeconds * 1000);

        activeGames.get(channelId).timeoutHandle = timeout;

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
        await interaction.reply({ content: `🔄 Scores have been reset to 0 for **${scores.team1Name}** and **${scores.team2Name}**.` });
    }
});

// Monitor Chat Messages for "correct", "incorrect", Taboo Violations, and Attempt Limits
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const game = activeGames.get(channelId);
    if (!game) return;

    const contentLower = message.content.toLowerCase().trim();
    const scores = getGuildScores(message.guild.id);

    // 1. Plain-Text Command: CORRECT GUESS
    if (contentLower === 'correct') {
        clearTimeout(game.timeoutHandle);
        activeGames.delete(channelId);

        if (game.team === 1) scores.team1Score += game.plusPoints;
        else scores.team2Score += game.plusPoints;

        const winEmbed = new EmbedBuilder()
            .setTitle('🎉 CORRECT GUESS!')
            .setColor('#2ed573')
            .setDescription(`**${game.activeTeamName}** successfully guessed the word **${game.word.toUpperCase()}**! +${game.plusPoints} Points awarded.`);

        return message.reply({ embeds: [winEmbed] });
    }

    // 2. Plain-Text Command: INCORRECT / WRONG / PASS
    if (['incorrect', 'wrong', 'pass'].includes(contentLower)) {
        clearTimeout(game.timeoutHandle);
        activeGames.delete(channelId);

        const failEmbed = new EmbedBuilder()
            .setTitle('❌ ROUND ENDED!')
            .setColor('#ff6b6b')
            .setDescription(`**${game.activeTeamName}** did not guess the word **${game.word.toUpperCase()}**! No points awarded.`)
            .setFooter({ text: 'Host can now set up the next round with /taboo for the next team.' });

        return message.reply({ embeds: [failEmbed] });
    }

    // 3. Monitor Active Describer Messages
    if (message.author.id === game.describerId) {
        game.descriptionsCount += 1;

        // Check for taboo words in describer's text
        const violatedTaboo = game.taboos.find(taboo => contentLower.includes(taboo));

        if (violatedTaboo) {
            // Deduct points from active team
            if (game.team === 1) scores.team1Score = Math.max(0, scores.team1Score - game.minusPoints);
            else scores.team2Score = Math.max(0, scores.team2Score - game.minusPoints);

            clearTimeout(game.timeoutHandle);
            activeGames.delete(channelId);

            const tabooEmbed = new EmbedBuilder()
                .setTitle('❌ TABOO WORD VIOLATION!')
                .setColor('#ff4757')
                .setDescription(`<@${message.author.id}> said **"${violatedTaboo}"**, which is a taboo word!`)
                .addFields({ name: 'Penalty', value: `**${game.activeTeamName}** loses ${game.minusPoints} point(s) (-${game.minusPoints}). Round over!` });

            return message.reply({ embeds: [tabooEmbed] });
        }

        // Check description count limit (Max 3)
        if (game.descriptionsCount >= game.maxDescriptions) {
            clearTimeout(game.timeoutHandle);
            activeGames.delete(channelId);

            const limitEmbed = new EmbedBuilder()
                .setTitle('⚠️ 3 DESCRIPTIONS REACHED!')
                .setColor('#ffa502')
                .setDescription(`<@${message.author.id}> has used all 3 description attempts. Round ended without a point.`);

            return message.reply({ embeds: [limitEmbed] });
        } else {
            // Give reaction indicating description received (out of 3)
            await message.react('👍');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);