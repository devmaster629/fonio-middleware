import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HostawayModule } from '../hostaway/hostaway.module';
import { RulesModule } from '../rules/rules.module';
import { FonioActivityService } from './fonio-activity.service';
import { FonioAvailabilityService } from './fonio-availability.service';
import { FonioBookingOfferService } from './fonio-booking-offer.service';
import { FonioCallContextService } from './fonio-call-context.service';
import { FonioCheckinEmailService } from './fonio-checkin-email.service';
import { FonioController } from './fonio.controller';
import { FonioPaymentService } from './fonio-payment.service';
import { FonioRequestsService } from './fonio-requests.service';
import { FonioVerificationService } from './fonio-verification.service';

@Module({
  imports: [
    HostawayModule,
    RulesModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get('JWT_EXPIRES_IN') ?? '2h',
        },
      }),
    }),
  ],
  controllers: [FonioController],
  providers: [
    FonioAvailabilityService,
    FonioCallContextService,
    FonioVerificationService,
    FonioRequestsService,
    FonioPaymentService,
    FonioCheckinEmailService,
    FonioBookingOfferService,
    FonioActivityService,
  ],
  exports: [FonioCallContextService, FonioVerificationService],
})
export class FonioModule {}
