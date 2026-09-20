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


// underscore-only filename metadata must still parse
{
  const c=__test.classifyMessage(
    fileMessage('SOLO_LEVELING_S02E15_VOSTFR_1080p.mkv',''),
    {username:'anime_source',title:'Anime Source'}
  );
  assert.equal(c.kind,'episode');
  assert.equal(c.season,2);
  assert.equal(c.episode,15);
  assert.equal(c.language,'VOSTFR');
  assert.equal(c.quality,'1080p');
}

// adult-focused source channels are rejected even when episode-like files are present
{
  const stats=__test.sourceStats([
    fileMessage('Some_Anime_S01E01_VF.mkv'),
    fileMessage('Some_Anime_S01E02_VF.mkv')
  ],{title:'HENTAIL HUB',username:'adult_hentai_zone'});
  assert.equal(stats.classification,'blocked');
}


// episode subtitles/hashes must collapse to one common series prefix
{
  const source={username:'generic_anime',title:'Anime Hebdo VF'};
  const messages=[
    fileMessage('That_Time_I_Got_Reincarnated_as_a_Slime_S04E13_New_Companions_VF.mkv'),
    fileMessage('That_Time_I_Got_Reincarnated_as_a_Slime_S04E14_The_Black_Numbers_VF.mkv'),
    fileMessage('That_Time_I_Got_Reincarnated_as_a_Slime_S04E15_An_Unsettling_Feeling_VF.mkv')
  ];
  const anchors=__test.deriveRawAnchors(messages,source);
  assert.ok(anchors.some(x=>/That Time I Got Reincarnated as a Slime/i.test(x)),JSON.stringify(anchors));
}

{
  assert.equal(__test.cleanSeriesTitle('%5BErai-raws%5D%20Blue%20Lock%20S01E12%20%5B1080p%5D.mkv'),'Blue Lock');
}


// blockquote caption formatting
{
  const q=__test.quotedCaption({
    kind:'episode',
    title:'BLACK TORCH',
    season:1,
    episode:2,
    language:'VF',
    quality:'1080p'
  });
  assert.ok(q.startsWith('<blockquote>'));
  assert.ok(q.endsWith('</blockquote>'));
  assert.ok(q.includes('BLACK TORCH'));
}


// caption must beat a generic filename when identifying the anime
{
  const msg=fileMessage('too.mp4','Classroom of the Elite S04 EP16 VOSTFR');
  const ep=__test.parseEpisode(msg.message+'\n'+msg.document.attributes[0].fileName);
  const title=__test.titleFromMessage(msg,ep);
  assert.match(title,/Classroom of the Elite/i);
}

// a channel's current anime must never force an unrelated episode into that series
{
  const wrong=__test.bestAnchor('Classroom of the Elite',[
    {raw:'BLACK TORCH',canonicalTitle:'BLACK TORCH',anilistId:187538},
    {raw:'Mushoku Tensei: Jobless Reincarnation',canonicalTitle:'Mushoku Tensei: Jobless Reincarnation',anilistId:108465}
  ]);
  assert.equal(wrong,null);
}

// historical posts remain grouped from their own titles even if the channel was renamed later
{
  const source={username:'classroom_of_the_elitevf',title:'Mushoku Tensei 🇫🇷'};
  const messages=[
    fileMessage('Classroom_of_the_Elite_S04E01_VOSTFR.mkv','Classroom of the Elite S04 EP01 VOSTFR'),
    fileMessage('Classroom_of_the_Elite_S04E02_VOSTFR.mkv','Classroom of the Elite S04 EP02 VOSTFR'),
    fileMessage('Classroom_of_the_Elite_S04E03_VOSTFR.mkv','Classroom of the Elite S04 EP03 VOSTFR')
  ];
  const anchors=__test.deriveRawAnchors(messages,source);
  assert.ok(anchors.some(x=>/Classroom of the Elite/i.test(x)),JSON.stringify(anchors));
  assert.ok(!anchors.some(x=>/Mushoku/i.test(x)),JSON.stringify(anchors));
}
