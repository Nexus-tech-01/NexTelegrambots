import { eventText, languageOf } from './_shared.mjs';
import * as nexgame from './nexgame.mjs';
import * as nexai from './nexai.mjs';

export const adapterManifest = Object.freeze({
  version:'1.1.0',
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
        ? 'NexMeta est connecté à Nexus. Choisis un service ou écris directement à NexAI.'
        : 'NexMeta is connected to Nexus. Choose a service or chat directly with NexAI.',
      quickReplies:[
        {title:'Download',payload:'/download'},
        {title:'Games',payload:'/game'},
        {title:'Stickers',payload:'/sticker'},
        {title:'Whisper',payload:'/whisper'},
        {title:'NexAI',payload:'/ai'}
      ]
    };
  }
  return nexai.handle(envelope);
}
export default handle;
