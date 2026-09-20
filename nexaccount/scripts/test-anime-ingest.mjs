import assert from 'node:assert/strict';
import { __test } from '../anime-ingest.mjs';

const fileMessage=(name,caption='')=>({
  message:caption,
  document:{
    mimeType:'video/x-matroska',
    attributes:[{fileName:name}]
  }
});

{
  const x=__test.parseEpisode('Classroom of the Elite S04E15 VOSTFR 1080p');
  assert.equal(x.season,4);
  assert.equal(x.episode,15);
}

{
  const c=__test.classifyMessage(
    fileMessage('@BadSource_BLACK_TORCH_S1_EP2_VF_1080p.mkv','Black Torch S1 EP2 VF @BadSource'),
    {username:'BadSource',title:'Bad Source'}
  );
  assert.equal(c.kind,'episode');
  assert.equal(c.season,1);
  assert.equal(c.episode,2);
  assert.equal(c.language,'VF');
  assert.equal(c.quality,'1080p');
  assert.ok(!c.cleanedFilename.includes('@BadSource'));
  assert.ok(!c.cleanedCaption.includes('@BadSource'));
}

{
  const c=__test.classifyMessage({
    message:'🔞 Adult promo — join our channel for porn',
    photo:{id:1}
  },{});
  assert.equal(c.kind,'blocked');
}

{
  const sample=[
    fileMessage('Anime_Name_S01E01_VOSTFR.mkv'),
    fileMessage('Anime_Name_S01E02_VOSTFR.mkv'),
    fileMessage('Anime_Name_S01E03_VOSTFR.mkv'),
    {message:'Pronostic 1XBET jackpot',photo:{id:1}},
    {message:'Random chat'}
  ];
  const stats=__test.sourceStats(sample,{});
  assert.equal(stats.classification,'mixed');
  assert.equal(stats.animeSignals,3);
  assert.equal(stats.blockedSignals,1);
}

console.log('NexAnime ingest regression tests: OK');
