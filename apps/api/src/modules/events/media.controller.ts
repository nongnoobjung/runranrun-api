import { Controller, Get, Param, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { problems } from '../../common/problem';
import { OrgEventImagesService } from '../org/org-event-images.service';

/**
 * Public images of event pages, for anyone. The web app forwards /media/* here. A file never changes under its id
 * (a new upload gets a new id), so browsers and CDNs may keep it for a year.
 */
@Controller('media')
export class MediaController {
  constructor(private readonly images: OrgEventImagesService) {}

  @Get('event-images/:file')
  async eventImage(@Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/i.exec(file)?.[1];
    const image = id ? await this.images.publicFile(id.toLowerCase()) : null;
    if (!image) throw problems.notFound('Image');
    void reply
      .header('content-type', image.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff');
    return image.body;
  }
}
