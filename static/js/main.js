'use strict';
/* main: the page's single entry point (index.html loads only this). */
import { installHooks, boot } from './app.js';
import { initDiscord } from './discord.js';
import { BigConBots } from '../bots.js';

/* The bot policy ships with the page; a seat falls back to the away path if it is ever absent. */
installHooks({ bots: () => BigConBots });
/* The ONE place anything of the game is put on window: a devtools / simulator handle for
   the bot policy (BigConBots.setVariant, .weights, ...). Nothing in the game reads it. */
window.BigConBots = BigConBots;
boot();
initDiscord();
