import { eventText, languageOf } from './_shared.mjs';
import * as nexgame from './nexgame.mjs';

export const adapterManifest = Object.freeze({
  version:'1.0.0',
  mode:'router',
  productionReady:true,
  capabilities:['active_game_stickiness','default_service_menu']
});

export async function handle(envelope) {
  if (nexgame.hasActiveSession(envelope)) return nexgame.handle(envelope);
  const lang = languageOf(envelope);
  const text = eventText(envelope);
  if (/^\/?(?:start|help)$/i.test(text) || !text) {
    return {
      text: lang === 'fr'
        ? 'NexMeta est connecté à Nexus. Choisis un service ou écris une commande.'
        : 'NexMeta is connected to Nexus. Choose a service or send a command.',
      quickReplies:[
        {title:'Download',payload:'/download'},
        {title:'Games',payload:'/game'},
        {title:'Stickers',payload:'/sticker'},
        {title:'Groups',payload:'/group list'},
        {title:'Channels',payload:'/channel help'}
      ]
    };
  }
  return {
    text: lang === 'fr'
      ? 'Commande non reconnue. Essaie /download, /game, /sticker, /group ou /channel.'
      : 'Unknown command. Try /download, /game, /sticker, /group or /channel.'
  };
}
export default handle;
