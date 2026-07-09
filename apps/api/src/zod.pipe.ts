import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/** Zod 即校验层:契约来自 @glassbox/contracts,不引入 class-validator(总纲 §4) */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "validation failed",
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
