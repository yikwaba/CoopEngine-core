import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { ProductsService } from './products.service';

class SavingsProductDto {
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsNumber()
  interestRatePa!: number;

  @IsNumber()
  minDeposit!: number;

  @IsBoolean()
  allowWithdrawal!: boolean;
}

class LoanProductDto {
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsNumber()
  interestRatePa!: number;

  @IsIn(['FLAT', 'REDUCING'])
  interestMethod!: 'FLAT' | 'REDUCING';

  @IsNumber()
  multiplier!: number;

  @IsNumber()
  minPrincipal!: number;

  @IsOptional()
  @IsNumber()
  maxPrincipal!: number | null;
}

class StatusDto {
  @IsIn(['ACTIVE', 'INACTIVE'])
  status!: 'ACTIVE' | 'INACTIVE';
}

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('savings')
  @RequirePermissions('products.view')
  listSavings(@CurrentUser() user: AuthPrincipal) {
    return this.productsService.listSavings(user.organizationId);
  }

  @Post('savings')
  @RequirePermissions('products.manage')
  createSavings(@CurrentUser() user: AuthPrincipal, @Body() dto: SavingsProductDto) {
    return this.productsService.createSavings(user.organizationId, user, dto);
  }

  @Patch('savings/:id')
  @RequirePermissions('products.manage')
  updateSavings(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SavingsProductDto,
  ) {
    return this.productsService.updateSavings(user.organizationId, user, id, dto);
  }

  @Post('savings/:id/status')
  @RequirePermissions('products.manage')
  setSavingsStatus(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StatusDto,
  ) {
    return this.productsService.setStatus(user.organizationId, user, 'savings', id, dto.status);
  }

  @Get('loans')
  @RequirePermissions('products.view')
  listLoans(@CurrentUser() user: AuthPrincipal) {
    return this.productsService.listLoans(user.organizationId);
  }

  @Post('loans')
  @RequirePermissions('products.manage')
  createLoan(@CurrentUser() user: AuthPrincipal, @Body() dto: LoanProductDto) {
    return this.productsService.createLoan(user.organizationId, user, dto);
  }

  @Patch('loans/:id')
  @RequirePermissions('products.manage')
  updateLoan(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LoanProductDto,
  ) {
    return this.productsService.updateLoan(user.organizationId, user, id, dto);
  }

  @Post('loans/:id/status')
  @RequirePermissions('products.manage')
  setLoanStatus(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StatusDto,
  ) {
    return this.productsService.setStatus(user.organizationId, user, 'loan', id, dto.status);
  }
}
