import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  BOARD_CLIENT_HEADER,
  BOARD_FOCUS_HEADER,
  type BoardResponse,
  type CommandRequest,
  type CreateProjectRequest,
  type CreateTaskRequest,
  type ResultsResponse,
  type SyncRequest,
  type SyncResponse,
  type UpdateProjectRequest,
  type UpdateTaskRequest,
} from '@tm/protocol/wire';
import type { Project, Task } from '@tm/shared/model';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { MirrorService } from './mirror.service';

/**
 * The mirror API: `SyncRequest`/`SyncResponse`, `CommandRequest` and
 * `BoardResponse` are `@tm/protocol/wire`'s own interfaces, accepted and
 * returned as-is rather than redeclared as NestJS DTO classes — they're
 * plain, framework-agnostic shapes shared with apps/client and apps/web, and
 * a parallel DTO class here would be exactly the kind of copy the wire
 * package exists to prevent.
 *
 * Guarded by {@link IamAuthGuard}, which resolves the caller's `accountId` —
 * read here via `@AccountId()` and threaded into every `MirrorService` call.
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class MirrorController {
  constructor(private readonly mirror: MirrorService) {}

  @Post('sync')
  sync(@AccountId() accountId: string, @Body() body: SyncRequest): Promise<SyncResponse> {
    return this.mirror.sync(accountId, body);
  }

  /** An ad-hoc task, written directly rather than relayed — see `CreateTaskRequest` on the wire. */
  @Post('tasks')
  @HttpCode(HttpStatus.CREATED)
  createTask(@AccountId() accountId: string, @Body() body: CreateTaskRequest): Promise<Task> {
    return this.mirror.createTask(accountId, body);
  }

  /** Edit, move or hand-set a mirrored task's status — see `UpdateTaskRequest` on the wire. */
  @Patch('tasks/:id')
  updateTask(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: UpdateTaskRequest,
  ): Promise<Task> {
    return this.mirror.updateTask(accountId, id, body);
  }

  /** Drop a mirrored task (and its steps) — see `MirrorService.deleteTask`. */
  @Delete('tasks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTask(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    await this.mirror.deleteTask(accountId, id);
  }

  /** A project, written directly rather than relayed — see `CreateProjectRequest` on the wire. */
  @Post('projects')
  @HttpCode(HttpStatus.CREATED)
  createProject(
    @AccountId() accountId: string,
    @Body() body: CreateProjectRequest,
  ): Promise<Project> {
    return this.mirror.createProject(accountId, body);
  }

  /** Edit a mirrored project — see `UpdateProjectRequest` on the wire. */
  @Patch('projects/:id')
  updateProject(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: UpdateProjectRequest,
  ): Promise<Project> {
    return this.mirror.updateProject(accountId, id, body);
  }

  /** Drop a mirrored project (and its tasks) — see `MirrorService.deleteProject`. */
  @Delete('projects/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteProject(@AccountId() accountId: string, @Param('id') id: string): Promise<void> {
    await this.mirror.deleteProject(accountId, id);
  }

  @Post('commands')
  @HttpCode(HttpStatus.ACCEPTED)
  async commands(
    @AccountId() accountId: string,
    @Body() body: CommandRequest,
  ): Promise<{ ok: true }> {
    await this.mirror.enqueueCommand(accountId, body);
    return { ok: true };
  }

  @Get('board')
  board(
    @AccountId() accountId: string,
    @Query('since') since: string | undefined,
    @Headers(BOARD_CLIENT_HEADER) clientId: string | undefined,
    @Headers(BOARD_FOCUS_HEADER) focusHeader: string | undefined,
  ): Promise<BoardResponse> {
    return this.mirror.board(accountId, since, clientId, focusHeader === 'true');
  }

  /**
   * What the desktop answered, for the commands THIS caller issued — the return half of a
   * relayed `ipc-invoke`.
   *
   * The caller identifies itself with the same `X-TM-Client-Id` header `GET /v1/board` uses
   * as its presence beat, and that value is what a command's `issuedBy` was set from, so no
   * new identity is invented for this route. Without it there is no scope to read at all,
   * which is an empty answer rather than an error: a caller that cannot name itself has
   * nothing awaiting it by definition.
   */
  @Get('results')
  results(
    @AccountId() accountId: string,
    @Query('since') since: string | undefined,
    @Headers(BOARD_CLIENT_HEADER) clientId: string | undefined,
  ): Promise<ResultsResponse> {
    if (!clientId) return Promise.resolve({ results: [], cursor: since ?? '' });
    return this.mirror.resultsSince(accountId, clientId, since);
  }
}
