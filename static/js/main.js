'use strict';
/* main: the page's single entry point (index.html loads only this). */
import { installHooks, boot } from './app.js';
import { initDiscord } from './discord.js';
import { BigConBots } from '../bots.js';

/* The bot policy ships with the page; a seat falls back to the away path if it is ever absent. */
installHooks({ bots: () => BigConBots });
boot();
initDiscord();
