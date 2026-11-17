import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthContext, CatalogConfirmInput } from '@competition/contracts';
import { AuthGuard, CurrentUser } from '../platform/auth.module';
import { DocumentService } from '../services/document.service';
import { ParseService } from '../services/parse.service';
import { DraftService } from '../services/draft.service';
import { CompetitionService } from '../services/competition.service';
import { AppException } from '../platform/app-exception';

function assertCanPublish(publish: unknown, user: AuthContext): void {
  if (publish === true && !user.roles.some(role => ['admin', 'editor', 'reviewer'].includes(role))) {
    throw new AppException('AUTH_FORBIDDEN');
  }
}

interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller()
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentService,
    private readonly parse: ParseService,
    private readonly drafts: DraftService,
    private readonly competitions: CompetitionService,
  ) {}

  @Post('documents')
  @UseInterceptors(FilesInterceptor('files', 10))
  async upload(
    @UploadedFiles() files: UploadedFile[],
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.documents.upload(files ?? [], user.userId);
  }

  @Get('documents')
  async listDocuments(@CurrentUser() user: AuthContext): Promise<unknown> {
    return this.documents.list(user.userId);
  }

  @Delete('documents/:documentId')
  async deleteDocument(
    @Param('documentId') documentId: string,
    @CurrentUser() user: AuthContext,
  ): Promise<{ deleted: true }> {
    return this.documents.delete(documentId, user.userId);
  }

  @Get('documents/:documentId/runs')
  async documentRuns(@Param('documentId') documentId: string, @CurrentUser() user: AuthContext): Promise<unknown> {
    return this.parse.runs(documentId, user.userId);
  }

  @Get('documents/:documentId/file')
  async download(
    @Param('documentId') documentId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @CurrentUser() user: AuthContext,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.documents.readFile(documentId, user.userId, Number(exp), sig);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    res.send(result.buffer);
  }

  @Post('documents/:documentId/parse')
  async parseDocument(
    @Param('documentId') documentId: string,
    @Body() body: { trigger?: 'user_request' | 'reparse' },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.parse.enqueue(documentId, body.trigger ?? 'user_request', user.userId);
  }

  @Get('parse-tasks')
  async listTasks(@CurrentUser() user: AuthContext, @Query('status') status?: string): Promise<unknown> {
    return this.parse.listTasks(status, user.userId);
  }

  @Get('parse-tasks/:taskId')
  async task(@Param('taskId') taskId: string, @CurrentUser() user: AuthContext): Promise<unknown> {
    const preview = await this.parse.preview(taskId, user.userId);
    return preview;
  }

  @Get('parse-tasks/:taskId/preview')
  async preview(@Param('taskId') taskId: string, @CurrentUser() user: AuthContext): Promise<unknown> {
    return this.parse.preview(taskId, user.userId);
  }

  @Post('parse-tasks/:taskId/confirm')
  async confirm(
    @Param('taskId') taskId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    assertCanPublish(body?.publish, user);
    return this.competitions.confirmFromParse(taskId, body ?? {}, user.userId);
  }

  @Post('parse-tasks/:taskId/catalog/confirm')
  async confirmCatalog(@Param('taskId') taskId: string, @Body() body: CatalogConfirmInput, @CurrentUser() user: AuthContext): Promise<unknown> {
    assertCanPublish(body?.publish, user);
    return this.competitions.confirmCatalog(taskId, body, user.userId);
  }

  @Post('drafts')
  async createDraft(
    @Body() body: { title?: string; payload?: Record<string, unknown>; documentIds?: string[] },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    return this.drafts.create(user.userId, body);
  }

  @Get('drafts')
  async listDrafts(@CurrentUser() user: AuthContext): Promise<unknown> {
    return this.drafts.list(user.userId);
  }

  @Patch('drafts/:draftId')
  async updateDraft(
    @Param('draftId') draftId: string,
    @Body() body: { title?: string; payload?: Record<string, unknown>; documentIds?: string[] },
    @CurrentUser() user: AuthContext,
  ): Promise<unknown> {
    const expected = body.payload && typeof body.payload.version === 'number' ? body.payload.version : undefined;
    return this.drafts.update(draftId, user.userId, body, expected);
  }
}
