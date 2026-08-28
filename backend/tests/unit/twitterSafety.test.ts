import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js',()=>({config:{twitter:{disabled:true}}}));
vi.mock('../../src/utils/logger.js',()=>({createLogger:()=>({info:vi.fn(),error:vi.fn(),warn:vi.fn(),success:vi.fn()})}));
import { TwitterApiClient } from '../../src/services/twitter/api/TwitterApiClient.js';
import { TwitterAuthManager } from '../../src/services/twitter/api/TwitterAuthManager.js';
import { assertTwitterEnabled } from '../../src/services/twitter/twitterPolicy.js';
const api = new TwitterApiClient(new Proxy({},{get(){throw new Error('Credentials must not be read');}}) as any);
describe('X disabled is enforced at API boundary',()=>{
 it('rejects before any side effect',()=>expect(assertTwitterEnabled).toThrow('TWITTER_DISABLED'));
 it.each(['fetchTweetContent','postTweetByApi','postTweet','uploadMedia','postQuoteTweet','likeTweet','retweetTweet','getLatestTweets','getReplies','advancedSearch','fetchTrends','setupWebhookRule','setupQuoteRTWebhookRule','deactivateWebhookRule','callWithRetry'])('blocks %s, including direct invocation and retry',async name=>{
   await expect((api as any)[name]()).rejects.toThrow('TWITTER_DISABLED');
 });
 it.each(['login1Step','login2Step','loginV2','ensureLoginCookies'])('blocks direct authentication entry %s',async name=>{
   await expect((TwitterAuthManager.prototype as any)[name].call({})).rejects.toThrow('TWITTER_DISABLED');
 });
});
