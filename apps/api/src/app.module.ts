import { Module } from '@nestjs/common';
import { PrismaModule } from './platform/prisma.module';
import { AuthModule } from './platform/auth.module';
import { AuditModule } from './platform/audit.module';
import { StorageModule } from './platform/storage.module';
import { ConfigModule } from './config/config.module';
import { HealthController } from './controllers/health.controller';
import { DocumentsController } from './controllers/documents.controller';
import { CompetitionsController } from './controllers/competitions.controller';
import { DashboardController } from './controllers/dashboard.controller';
import { SignupSourceController } from './controllers/signup-source.controller';
import { AgentController } from './controllers/agent.controller';
import { MiscController } from './controllers/misc.controller';
import { CrawlerController } from './controllers/crawler.controller';
import { SystemSettingsController } from './controllers/system-settings.controller';
import { SafeEgressService } from './platform/safe-fetch';
import { RobotsService } from './platform/robots.service';
import { RateLimiterService } from './platform/rate-limiter.service';
import { AgentLogService } from './platform/agent-log.service';
import { ArtifactService } from './services/artifact.service';
import { LlmService } from './services/llm.service';
import { CrawlerService } from './services/crawler.service';
import { TrackSplitService } from './services/track-split.service';
import { VerificationService } from './services/verification.service';
import { SystemService } from './services/system.service';
import { ParserClient } from './services/parser-client.service';
import { ExtractionService } from './services/extraction.service';
import { ParseService } from './services/parse.service';
import { DocumentService } from './services/document.service';
import { DraftService } from './services/draft.service';
import { CompetitionService } from './services/competition.service';
import { DashboardService } from './services/dashboard.service';
import { SignupService } from './services/signup.service';
import { SourceService } from './services/source.service';
import { AgentService } from './services/agent.service';
import { CompetitionDiscoveryService } from './services/competition-discovery.service';

@Module({
  imports: [PrismaModule, AuditModule, StorageModule, ConfigModule, AuthModule],
  controllers: [
    HealthController,
    DocumentsController,
    CompetitionsController,
    DashboardController,
    SignupSourceController,
    AgentController,
    MiscController,
    CrawlerController,
    SystemSettingsController,
  ],
  providers: [
    ParserClient,
    ExtractionService,
    ParseService,
    DocumentService,
    DraftService,
    CompetitionService,
    DashboardService,
    SignupService,
    SourceService,
    AgentService,
    { provide: AgentLogService, useFactory: () => new AgentLogService() },
    CompetitionDiscoveryService,
    SafeEgressService,
    RobotsService,
    RateLimiterService,
    ArtifactService,
    LlmService,
    CrawlerService,
    TrackSplitService,
    VerificationService,
    SystemService,
  ],
})
export class AppModule {}
