// Slash command definitions (registered per guild by scripts/register-commands.js).
import { SlashCommandBuilder } from 'discord.js';

const date = (o, name, desc, required = false) => o.addStringOption((x) => x.setName(name).setDescription(desc).setRequired(required).setMinLength(10).setMaxLength(10));
const note = (o) => o.addStringOption((x) => x.setName('note').setDescription('Short note (max 80 characters)').setMaxLength(80));

export const commands = [
  note(new SlashCommandBuilder().setName('clock-in').setDescription('Start your working day (status: Online)')),

  new SlashCommandBuilder().setName('clock-out').setDescription('End your working day (status: Offline)'),

  new SlashCommandBuilder().setName('status').setDescription('Set or check availability')
    .addSubcommand((s) => s.setName('set').setDescription('Set your own working status')
      .addStringOption((o) => o.setName('value').setDescription('Your status').setRequired(true).addChoices(
        { name: 'Online', value: 'ONLINE' },
        { name: 'Partial (slow response)', value: 'PARTIAL' },
        { name: 'On-Meeting (do not disturb)', value: 'ON_MEETING' },
      ))
      .addIntegerOption((o) => o.setName('minutes').setDescription('On-Meeting only: how long (default 30)').setMinValue(5).setMaxValue(240)))
    .addSubcommand((s) => s.setName('check').setDescription("See a colleague's status and expected response")
      .addUserOption((o) => o.setName('user').setDescription('Who?').setRequired(true))),

  note(date(date(new SlashCommandBuilder().setName('sick').setDescription('Report sick (management is notified)'),
    'from', 'Start date YYYY-MM-DD (default: today)'), 'to', 'End date YYYY-MM-DD (default: same day)')),

  note(date(date(new SlashCommandBuilder().setName('on-leave').setDescription('Request leave'),
    'from', 'Start date YYYY-MM-DD', true), 'to', 'End date YYYY-MM-DD', true)),

  new SlashCommandBuilder().setName('myhours').setDescription('Your own hours (private)')
    .addStringOption((o) => o.setName('period').setDescription('Period').addChoices(
      { name: 'Today', value: 'today' }, { name: 'This week', value: 'week' }, { name: 'This month', value: 'month' },
    )),

  new SlashCommandBuilder().setName('report-attendance').setDescription('Management: who is in, out, sick, missing today'),

  new SlashCommandBuilder().setName('presence-admin').setDescription('Admin: corrections and holidays')
    .addSubcommand((s) => s.setName('fix-session').setDescription('Correct clock-in/out times')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((o) => o.setName('clock_in').setDescription('HH:MM WITA'))
      .addStringOption((o) => o.setName('clock_out').setDescription('HH:MM WITA')))
    .addSubcommand((s) => s.setName('set-status').setDescription("Correct someone's status")
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('value').setDescription('Status').setRequired(true).addChoices(
        { name: 'Online', value: 'ONLINE' }, { name: 'Offline', value: 'OFFLINE' },
        { name: 'Sick', value: 'SICK' }, { name: 'On-Leave', value: 'ON_LEAVE' },
      )))
    .addSubcommand((s) => s.setName('holiday').setDescription('Add a holiday (no reminders that day)')
      .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Holiday name').setRequired(true).setMaxLength(60)))
    .addSubcommand((s) => s.setName('board').setDescription('Re-post and pin the status board')),
].map((c) => c.toJSON());
