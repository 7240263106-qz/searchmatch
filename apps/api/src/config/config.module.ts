import { Global, Module, OnModuleInit } from '@nestjs/common';
import { CredentialVault } from './credential-vault.service';
import { ConfigResolverService } from './config-resolver.service';
import { ConfigService } from './config.service';
import { ConfigTestService } from './config-test.service';
import { ReadinessService } from './readiness.service';
import { ConnectionRuntimeService } from './connection-runtime.service';
import { ConfigGateService } from './config-gate.service';
import { ClientBootstrapLogService } from './client-bootstrap-log.service';

@Global()
@Module({
  providers: [
    CredentialVault,
    ConfigResolverService,
    ConfigService,
    ConfigTestService,
    ReadinessService,
    ConnectionRuntimeService,
    ConfigGateService,
    ClientBootstrapLogService,
  ],
  exports: [
    CredentialVault,
    ConfigResolverService,
    ConfigService,
    ConfigTestService,
    ReadinessService,
    ConnectionRuntimeService,
    ConfigGateService,
    ClientBootstrapLogService,
  ],
})
export class ConfigModule implements OnModuleInit {
  constructor(private readonly resolver: ConfigResolverService) {}

  async onModuleInit(): Promise<void> {
    await this.resolver.ensureInitialized();
  }
}