import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ThrottlerException } from '@nestjs/throttler';
import type { ValidationError } from 'class-validator';
import type { Response } from 'express';

/** "targetAmount" -> "Target amount" */
const label = (field: string) => {
  const words = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Plain-English messages for class-validator constraints. */
function describe(field: string, key: string, raw: string, args?: unknown[]) {
  const name = label(field);
  const n = args?.[0];
  switch (key) {
    case 'isNotEmpty':
      return `${name} is required`;
    case 'isEmail':
      return 'Enter a valid email address';
    case 'minLength':
      return `${name} must be at least ${String(n)} characters`;
    case 'maxLength':
      return `${name} must be ${String(n)} characters or fewer`;
    case 'isInt':
      return `${name} must be a whole number`;
    case 'min':
      return `${name} must be at least ${Number(n).toLocaleString('en-NG')}`;
    case 'max':
      return `${name} must be ${Number(n).toLocaleString('en-NG')} or less`;
    case 'isIn':
    case 'isEnum':
      return `${name} has an invalid value`;
    case 'isUuid':
      return `${name} is not a valid ID`;
    case 'whitelistValidation':
      return `${name} is not a field we accept`;
    case 'isString':
      return `${name} must be text`;
    case 'isTimeZone':
      return `${name} is not a valid timezone`;
    default:
      return raw;
  }
}

// When a value breaks several rules, report the most basic one first.
const PRIORITY = [
  'whitelistValidation',
  'isDefined',
  'isNotEmpty',
  'isString',
  'isEmail',
  'minLength',
  'maxLength',
  'isInt',
  'min',
  'max',
];

function firstConstraint(c: Record<string, string> = {}) {
  const entries = Object.entries(c);
  const rank = (k: string) => {
    const i = PRIORITY.indexOf(k);
    return i < 0 ? PRIORITY.length : i;
  };
  return entries.sort(([a], [b]) => rank(a) - rank(b))[0] ?? [];
}

/**
 * Turns validation errors into `{ message, errors: { field: message } }` so the
 * frontend can show the first message as a toast and pin each one to its field.
 */
export function validationException(errors: ValidationError[]) {
  const fields: Record<string, string> = {};
  const walk = (list: ValidationError[], prefix = '') => {
    for (const e of list) {
      const path = prefix + e.property;
      const [key, raw] = firstConstraint(e.constraints);
      if (key && !fields[path]) {
        // Messages written on the DTO win over the generated ones.
        const custom =
          !raw.startsWith(e.property) && key !== 'whitelistValidation';
        fields[path] = custom ? raw : describe(e.property, key, raw);
      }
      if (e.children?.length) walk(e.children, `${path}.`);
    }
  };
  walk(errors);
  const messages = Object.values(fields);
  return new BadRequestException({
    statusCode: 400,
    message: messages[0] ?? 'Some of the details are invalid',
    errors: fields,
  });
}

/** Every error leaves the API as `{ statusCode, message, errors? }` with a readable message. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) this.log.error(exception);
    res.status(status).json(body);
  }

  private toBody(e: unknown): {
    status: number;
    body: Record<string, unknown>;
  } {
    if (e instanceof ThrottlerException) {
      return {
        status: 429,
        body: {
          statusCode: 429,
          message: 'Too many attempts. Please wait a minute and try again.',
        },
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const r = e.getResponse();
      const body =
        typeof r === 'string'
          ? { statusCode: status, message: r }
          : (r as Record<string, unknown>);
      if (Array.isArray(body.message)) body.message = body.message[0];
      if (status === 413) body.message = 'That file is too large';
      if (/uuid is expected/i.test(String(body.message)))
        body.message = 'That link looks broken. Go back and try again.';
      if (status === 404 && body.message?.toString().startsWith('Cannot '))
        body.message = 'We couldn’t find what you were looking for';
      return { status, body };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        const target = (e.meta?.target as string[] | undefined)?.[0];
        return {
          status: 409,
          body: {
            statusCode: 409,
            message: target
              ? `${label(target)} is already in use`
              : 'This already exists',
          },
        };
      }
      if (e.code === 'P2025') {
        return {
          status: 404,
          body: {
            statusCode: 404,
            message: 'That record no longer exists. It may have been deleted.',
          },
        };
      }
    }
    if (
      e instanceof Prisma.PrismaClientInitializationError ||
      (e instanceof Prisma.PrismaClientKnownRequestError &&
        ['P1001', 'P1002', 'P1008', 'P1017'].includes(e.code))
    ) {
      return {
        status: 503,
        body: {
          statusCode: 503,
          message:
            'We can’t reach the database right now. Please try again in a moment.',
        },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: 500,
        message:
          'Something went wrong on our side. Please try again, and if it keeps happening, let us know.',
      },
    };
  }
}
