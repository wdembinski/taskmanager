import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { AddProjectInput, Project, ProjectPatch, Task, TicketInput } from '@tm/shared/model';
import { AccountId } from '../iam/accountId.decorator';
import { IamAuthGuard } from '../iam/iamAuth.guard';
import { TicketsService, type TicketUpdateRequest } from './tickets.service';

/**
 * The server's own authoritative Project/Task writes, alongside `MirrorController`: that
 * controller only ever relays a Client's OWN deltas back to the account that pushed them,
 * and every route here originates a change of its own — see `TicketsService` for the rest
 * of the story, including why every write here bumps `rowVersion` exactly like a
 * desktop-pushed sync delta and needs no separate poll path.
 *
 * Guarded by the same `IamAuthGuard` as every other `/v1/*` route: `GET` reads, everything
 * else writes (see `iamAuth.guard.ts`'s `actionFor`).
 */
@Controller('v1')
@UseGuards(IamAuthGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('projects')
  listProjects(@AccountId() accountId: string): Promise<Project[]> {
    return this.tickets.listProjects(accountId);
  }

  @Post('projects')
  createProject(@AccountId() accountId: string, @Body() body: AddProjectInput): Promise<Project> {
    return this.tickets.createProject(accountId, body);
  }

  @Patch('projects/:id')
  updateProject(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: ProjectPatch,
  ): Promise<Project> {
    return this.tickets.updateProject(accountId, id, body);
  }

  @Get('projects/:projectId/tickets')
  listTickets(
    @AccountId() accountId: string,
    @Param('projectId') projectId: string,
  ): Promise<Task[]> {
    return this.tickets.listTasks(accountId, projectId);
  }

  @Post('projects/:projectId/tickets')
  createTicket(
    @AccountId() accountId: string,
    @Param('projectId') projectId: string,
    @Body() body: TicketInput,
  ): Promise<Task> {
    return this.tickets.createTicket(accountId, projectId, body);
  }

  @Patch('tickets/:id')
  updateTicket(
    @AccountId() accountId: string,
    @Param('id') id: string,
    @Body() body: TicketUpdateRequest,
  ): Promise<Task> {
    return this.tickets.updateTask(accountId, id, body);
  }
}
