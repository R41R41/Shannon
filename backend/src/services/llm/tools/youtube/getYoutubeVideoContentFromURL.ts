import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { YoutubeVideoInfoOutput } from '@shannon/common';
import { getYoutubeToolPort } from '../../../runtime/platformToolGateway.js';
import { logger } from '../../../../utils/logger.js';

export default class GetYoutubeVideoContentFromURLTool extends StructuredTool {
    name = 'get-youtube-video-content-from-url';
    description = 'YouTubeの動画URLから内容を取得するツール。サムネイル画像のURLも取得するので、このツールの使用後にdescribeImageツールで画像の内容を取得してください。';
    schema = z.object({
        url: z
            .string()
            .describe('取得したいYouTubeの動画のURL。有効なURLを指定してください。'),
    });

    private extractVideoId(url: string): string | null {
        let match = url.match(/v=([^&]+)/);
        if (match) return match[1];

        match = url.match(/youtu\.be\/([^\?\&]+)/);
        if (match) return match[1];

        match = url.match(/youtube\.com\/shorts\/([\w-]+)/);
        if (match) return match[1];

        return null;
    }

    async _call(data: z.infer<typeof this.schema>): Promise<string> {
        try {
            const url = data.url;
            const videoId = this.extractVideoId(url);
            if (!videoId) {
                return 'YouTubeの動画URLを指定してください。';
            }

            logger.info(`get-youtube-video-content-from-url ${videoId}`);

            const response = await getYoutubeToolPort().getVideoInfo(videoId) as YoutubeVideoInfoOutput;

            return `YouTubeの動画からコンテンツを取得しました。${JSON.stringify(response)} `;
        } catch (error) {
            logger.error('get-youtube-video-content-from-url error:', error);
            return `An error occurred while getting content from YouTube: ${error}`;
        }
    }
}
