import assert from 'node:assert/strict';
import { __test } from '../anime-ingest.mjs';

const fileMessage=(name,caption='')=>({
  message:caption,
  document:{
    mimeType:'video/x-matroska',
    attributes:[{fileName:name}]
  }
});

// A stale source may park a series before it starts, but must never interrupt
// an anime after episode publication has begun.
{
  assert.equal(__test.shouldParkTransientEpisode(
    {kind:'episode',seriesKey:'witch hat atelier'},
    {code:'SOURCE_UNAVAILABLE',message:'source_message_unavailable_for_runtime'},
    3,
    false
  ),true);
  assert.equal(__test.shouldParkTransientEpisode(
    {kind:'episode',seriesKey:'witch hat atelier'},
    {code:'SOURCE_UNAVAILABLE',message:'source_message_unavailable_for_runtime'},
    3,
    true
  ),false);
  assert.equal(__test.shouldParkTransientEpisode(
    {kind:'episode',seriesKey:'witch hat atelier'},
    {code:'SOURCE_UNAVAILABLE',message:'source_message_unavailable_for_runtime'},
    2,
    false
  ),false);
  assert.equal(__test.shouldParkTransientEpisode(
    {kind:'presentation',seriesKey:'witch hat atelier'},
    {code:'SOURCE_UNAVAILABLE',message:'source_message_unavailable_for_runtime'},
    5,
    false
  ),false);
}

// Scheduler contract: stale environment values must never regress the publishing cadence.
{
  assert.equal(__test.timing.publishMs,30_000);
  assert.ok(__test.timing.publishMs<=60_000);
  assert.equal(__test.timing.interSeriesMs,15*60_000);
  assert.ok(__test.timing.transientVariantRetryMs>=__test.timing.publishMs*2);
  const base=new Date('2026-01-01T00:00:00.000Z');
  assert.equal(__test.interSeriesDeadlineFrom(base).toISOString(),'2026-01-01T00:15:00.000Z');
}

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


// bullet-separated season/episode labels must keep the real season number
{
  const x=__test.parseEpisode('Classroom of the Elite\nS4 • EP12\nVOSTFR');
  assert.equal(x.season,4);
  assert.equal(x.episode,12);
}


// episode-numbered poster/synopsis cards are source context only and must not
// be published as fake episodes or repeated per-episode presentations
{
  const c=__test.classifyMessage({
    message:'Classroom of the Elite S04 EP16 VOSTFR\nCette semaine, la classe fait face à une nouvelle épreuve qui bouleverse complètement les alliances et les stratégies des élèves.',
    photo:{id:1}
  },{username:'anime_source',title:'Anime Source'});
  assert.equal(c.kind,'ignore');
  assert.equal(c.reason,'episode_image_card_context_only');
}



// A series-level synopsis image is still accepted once for the anime.
{
  const c=__test.classifyMessage({
    message:'Classroom of the Elite\nSynopsis\nLes élèves de la classe D affrontent un système scolaire fondé sur la compétition et la stratégie.',
    photo:{id:1}
  },{username:'anime_source',title:'Anime Source'});
  assert.equal(c.kind,'presentation');
  assert.equal(c.season,null);
  assert.equal(c.episode,null);
}

// conflicting caption/file anime identities must never be published
{
  const c=__test.classifyMessage(
    fileMessage(
      'Classroom_of_the_Elite_S04E15_VOSTFR_1080p.mkv',
      'Daemons of the Shadow Realm S01E01 VOSTFR'
    ),
    {username:'anime_source',title:'Anime Source'}
  );
  assert.equal(c.kind,'conflict');
  assert.equal(c.reason,'caption_filename_title_conflict');
}



// same anime name but conflicting caption/file episode numbers must be quarantined
{
  const c=__test.classifyMessage(
    fileMessage(
      'Classroom_of_the_Elite_S04E15_VOSTFR_1080p.mkv',
      'Classroom of the Elite S04E16 VOSTFR'
    ),
    {username:'anime_source',title:'Anime Source'}
  );
  assert.equal(c.kind,'conflict');
  assert.equal(c.reason,'caption_filename_episode_conflict');
}

// if caption omits the season, inherit it from the filename when episode number agrees
{
  const c=__test.classifyMessage(
    fileMessage(
      'Classroom_of_the_Elite_S04E15_VOSTFR_1080p.mkv',
      'Classroom of the Elite Episode 15 VOSTFR'
    ),
    {username:'anime_source',title:'Anime Source'}
  );
  assert.equal(c.kind,'episode');
  assert.equal(c.season,4);
  assert.equal(c.episode,15);
}

// the final source guard must reject the wrong episode even if the anime is correct
{
  const ok=__test.episodeIdentityCompatible(
    {kind:'episode',title:'Classroom of the Elite',anilistId:123,season:4,episode:15},
    {kind:'episode',title:'Classroom of the Elite',season:4,episode:15},
    {ok:true,canonicalTitle:'Classroom of the Elite',anilistId:123}
  );
  const wrongEpisode=__test.episodeIdentityCompatible(
    {kind:'episode',title:'Classroom of the Elite',anilistId:123,season:4,episode:15},
    {kind:'episode',title:'Classroom of the Elite',season:4,episode:16},
    {ok:true,canonicalTitle:'Classroom of the Elite',anilistId:123}
  );
  const wrongAnime=__test.episodeIdentityCompatible(
    {kind:'episode',title:'Classroom of the Elite',anilistId:123,season:4,episode:15},
    {kind:'episode',title:'Daemons of the Shadow Realm',season:4,episode:15},
    {ok:true,canonicalTitle:'Daemons of the Shadow Realm',anilistId:999}
  );
  assert.equal(ok,true);
  assert.equal(wrongEpisode,false);
  assert.equal(wrongAnime,false);
}


// reversed episode/season tokens used by several anime sources must keep season
{
  const x=__test.parseEpisode('Oshi no Ko E02 S2 VOSTFR');
  assert.equal(x.season,2);
  assert.equal(x.episode,2);
}

// live-action/K-drama channels must never become anime sources just because
// their files share a title with an anime adaptation
{
  const stats=__test.sourceStats([
    fileMessage('Oshi no Ko 2024 S01E01 VOSTFR 1080p.mkv'),
    fileMessage('Oshi no Ko 2024 S01E02 VOSTFR 1080p.mkv')
  ],{title:'K - Drama 🇫🇷',username:'Kdrama_French'});
  assert.equal(stats.classification,'blocked');
}


// numeric storage filenames are not anime titles and must not conflict with
// a valid anime title/episode supplied by the caption
{
  const c=__test.classifyMessage(
    fileMessage('5423777.mp4','Blue Lock S02 EP06 VF'),
    {username:'MANGAS_VFF',title:'ANIME VF'}
  );
  assert.equal(c.kind,'episode');
  assert.equal(c.title,'Blue Lock');
  assert.equal(c.season,2);
  assert.equal(c.episode,6);
}


// transiently failed episode copies cool down so another copy of the same episode
// can be tried without abandoning the active anime.
{
  const now=Date.parse('2026-09-30T00:00:00.000Z');
  assert.equal(__test.episodeVariantRetryReady({},now),true);
  assert.equal(__test.episodeVariantRetryReady({retryAfter:new Date(now-1)},now),true);
  assert.equal(__test.episodeVariantRetryReady({retryAfter:new Date(now+60_000)},now),false);
}

// episode variant preference must be deterministic: prefer VF first, then quality.
{
  const vf720=__test.episodeVariantScore({language:'VF',quality:'720p'});
  const vf480=__test.episodeVariantScore({language:'VF',quality:'480p'});
  const multi1080=__test.episodeVariantScore({language:'MULTI',quality:'1080p'});
  const vostfr1080=__test.episodeVariantScore({language:'VOSTFR',quality:'1080p'});
  assert.ok(vf720>vf480);
  assert.ok(vf480>multi1080);
  assert.ok(multi1080>vostfr1080);
}


// Completed newer seasons must never deduplicate or suppress older seasons
// discovered later. S1E01 and S2E01 are distinct publication identities.
{
  const s1=__test.releaseKey({title:'Devil May Cry',season:1,episode:1,language:'VF',quality:'1080p'});
  const s2=__test.releaseKey({title:'Devil May Cry',season:2,episode:1,language:'VF',quality:'1080p'});
  assert.notEqual(s1,s2);
}


// A temporarily unavailable source must stay retryable; quarantining the
// expected episode would deadlock strict ordering for every following episode.
{
  const transient=new Error('source_message_unavailable_for_runtime');
  transient.code='SOURCE_UNAVAILABLE';
  assert.equal(__test.isTransientPublishError(transient),true);
  assert.equal(__test.isTransientPublishError(new Error('source_message_unavailable_for_runtime')),true);
  const permanent=new Error('source_identity_mismatch');
  permanent.code='SOURCE_IDENTITY_MISMATCH';
  assert.equal(__test.isTransientPublishError(permanent),false);
}


// Source-specific platform numbering may call the same canonical cour/season
// "Season 2". Only collapse it when no distinct AniList sequel was resolved
// and the same episode is already published in an earlier season.
{
  const direct={ok:true,anilistId:196187,episodes:12};
  assert.equal(__test.inferredSeasonAlias({
    candidateSeason:2,episode:10,direct,
    sequel:{ok:true,anilistId:196187,episodes:12},
    priorSeason:1
  }),1);
  assert.equal(__test.inferredSeasonAlias({
    candidateSeason:2,episode:10,direct,
    sequel:{ok:true,anilistId:999999,episodes:12},
    priorSeason:1
  }),null);
  assert.equal(__test.inferredSeasonAlias({
    candidateSeason:2,episode:10,direct,
    sequel:{ok:false,temporary:false},
    priorSeason:0
  }),null);
}
