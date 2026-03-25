import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import dotenv from 'dotenv';
import { getEventBus } from '../../../eventBus/index.js';
import { EventBus } from '../../../eventBus/eventBus.js';
import { YoutubeClientOutput, YoutubeClientInput, YoutubeVideoInfoOutput } from '@shannon/common';
import { logger } from '../../../../utils/logger.js';

export default class GetYoutubeVideoContentFromURLTool extends StructuredTool {
    name = 'get-youtube-video-content-from-url';
    description = 'YouTubeの動画URLから内容を取得するツール。サムネイル画像のURLも取得するので、このツールの使用後にdescribeImageツールで画像の内容を取得してください。';
    schema = z.object({
        url: z
            .string()
            .describe('取得したいYouTubeの動画のURL。有効なURLを指定してください。'),
    });
    private eventBus: EventBus;
    constructor() {
        super();
        this.eventBus = getEventBus();
    }

    private extractVideoId(url: string): string | null {
        // 標準URL（v=）に対応
        let match = url.match(/v=([^&]+)/);
        if (match) return match[1];

        // 短縮URL（youtu.be/）に対応
        match = url.match(/youtu\.be\/([^\?\&]+)/);
        if (match) return match[1];

        // Shorts URL（youtube.com/shorts/）に対応
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

            const getContent = new Promise<YoutubeClientOutput>(async (resolve) => {
                this.eventBus.subscribe('tool:get_video_info', (event) => {
                    const { title, author, thumbnail, description, publishedAt, viewCount, likeCount, commentCount } = event.data as YoutubeVideoInfoOutput;
                    resolve({ title, author, thumbnail, description, publishedAt, viewCount, likeCount, commentCount });
                });
                await this.eventBus.publish({
                    type: 'youtube:get_video_info',
                    memoryZone: 'youtube',
                    data: {
                        videoId: videoId,
                    } as YoutubeClientInput,
                });
            });
            const response = await getContent;

            return `YouTubeの動画からコンテンツを取得しました。${JSON.stringify(response)} `;
        } catch (error) {
            logger.error('get-youtube-video-content-from-url error:', error);
            return `An error occurred while getting content from YouTube: ${error}`;
        }
    }
} 