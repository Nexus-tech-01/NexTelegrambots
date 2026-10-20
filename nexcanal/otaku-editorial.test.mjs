import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editorialKind,chooseEditorial,stripMarkup,formatOtakuEditorial,
  fetchAniListEditorial,parseAnnFeed,formatAnnNews,fetchLatestAnn
} from './otaku-editorial.mjs';

const manga={id:123,title:{english:'The Good Story',romaji:'Good Story'},description:'An adventure <b>without spoilers</b> &amp; mysteries.',countryOfOrigin:'KR',genres:['Fantasy','Drama'],chapters:40,status:'RELEASING',coverImage:{large:'https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/123.jpg'},siteUrl:'https://anilist.co/manga/123'};
test('editorial categories rotate and keep anime and manga distinct',()=>{
 assert.ok(['anime','manga','manhwa','webtoon'].includes(editorialKind('2026-10-19')));
 assert.ok(['trend_anime','trend_manga'].includes(editorialKind('2026-10-19','trending')));
 assert.notEqual(editorialKind('2026-10-19'),editorialKind('2026-10-20'));
});
test('manhwa filter requires Korean origin',()=>{
 const jp={...manga,id:124,countryOfOrigin:'JP'};
 assert.equal(chooseEditorial([jp,manga],'manhwa')?.id,123);
 assert.equal(chooseEditorial([jp],'manhwa'),null);
});
test('formatted recommendation uses source data without fabricated release date',()=>{
 const post=formatOtakuEditorial(manga,'manhwa');
 assert.match(post.text,/The Good Story/);
 assert.match(post.text,/without spoilers & mysteries/);
 assert.match(post.text,/anilist.co\/manga\/123/);
 assert.doesNotMatch(post.text,/2026|sortie le|Prime Video/);
 assert.match(post.text,/#Manhwa/);
});
test('AniList API query picks a sourced work',async()=>{
 let called=false;
 const post=await fetchAniListEditorial('manhwa',{fetcher:async(url,opts)=>{
   called=true;
   assert.equal(url,'https://graphql.anilist.co');
   assert.equal(JSON.parse(opts.body).variables.type,'MANGA');
   return {ok:true,json:async()=>({data:{Page:{media:[manga]}}})};
 }});
 assert.equal(post.id,'anilist:123');assert.ok(called);
});
test('RSS feed rejects stale items and cites the original source',()=>{
 const xml='<rss><channel><item><title><![CDATA[Anime Season Announced]]></title><link>https://www.animenewsnetwork.com/news/2026-10-19/example</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[Official visual revealed.]]></description><enclosure url="https://www.animenewsnetwork.com/images/test.jpg" type="image/jpeg"/></item></channel></rss>';
 const articles=parseAnnFeed(xml,{now:Date.parse('2026-10-19T12:00:00Z')});
 assert.equal(articles.length,1);
 const caption=formatAnnNews(articles[0]);
 assert.match(caption,/Source : Anime News Network/);
 assert.match(caption,/Official visual revealed/);
 assert.match(caption,/#OtakuNexus/);
 assert.equal(parseAnnFeed(xml,{now:Date.parse('2026-11-19T12:00:00Z')}).length,0);
});

test('Webtoon selection requires Korean origin AND a verified Webtoons tag',()=>{
 const verified={...manga,id:125,tags:[{name:'Webtoons'}]};
 const untagged={...manga,id:126,tags:[{name:'Romance'}]};
 const japanese={...verified,id:127,countryOfOrigin:'JP'};
 assert.equal(chooseEditorial([untagged,japanese,verified],'webtoon')?.id,125);
 assert.equal(chooseEditorial([untagged,japanese],'webtoon'),null);
 const post=formatOtakuEditorial(verified,'webtoon');
 assert.match(post.text,/#Webtoon/);
});
test('ANN news can be published from a sourced article even without RSS thumbnail',async()=>{
 const xml='<rss><channel><item><title>New Webtoon adaptation announced</title><link>https://www.animenewsnetwork.com/news/2026-10-19/webtoon</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description>Publisher confirms adaptation.</description></item></channel></rss>';
 const article=await fetchLatestAnn({
  now:Date.parse('2026-10-19T12:00:00Z'),
  fetcher:async()=>({ok:true,text:async()=>xml})
 });
 assert.equal(article.image,'');
 assert.match(formatAnnNews(article),/Publisher confirms adaptation/);
});
