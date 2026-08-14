import type { Action } from '../domain/actions.js';
import { FeedbackSummarizer } from '../feedback/summarizer.js';
import type { CommandResult, CommandTools } from '../tools/commands.js';
import type {
  ListWorkspaceResult,
  ReadWorkspaceResult,
  WorkspaceTools,
  WriteWorkspaceResult
} from '../tools/workspace.js';
import type { ActionDispatcher, DispatcherFeedback } from './agent-loop.js';

export interface WorkspaceActionTools {
  list(path?: string): Promise<ListWorkspaceResult>;
  read(path: string): Promise<ReadWorkspaceResult>;
  write(path: string, content: string): Promise<WriteWorkspaceResult>;
}

export interface CommandActionTools {
  runCommand(command: unknown, args: unknown): Promise<CommandResult>;
  runTests(): Promise<CommandResult>;
}

export interface ToolDispatcherOptions {
  workspace: WorkspaceActionTools | WorkspaceTools;
  commands: CommandActionTools | CommandTools;
  feedback?: FeedbackSummarizer;
}

/**
 * The only bridge from a policy-approved Action to the already fenced T04/T05
 * implementations. It never accepts raw paths or commands outside Action.
 */
export class ToolDispatcher implements ActionDispatcher {
  private readonly feedback: FeedbackSummarizer;

  constructor(private readonly options: ToolDispatcherOptions) {
    this.feedback = options.feedback ?? new FeedbackSummarizer();
  }

  async dispatch(action: Action): Promise<DispatcherFeedback> {
    switch (action.type) {
      case 'list_files':
        return workspaceFeedback(await this.options.workspace.list(action.path));
      case 'read_file':
        return workspaceFeedback(await this.options.workspace.read(action.path));
      case 'write_file':
        return workspaceFeedback(await this.options.workspace.write(action.path, action.content));
      case 'run_command':
        return commandFeedback(this.feedback, await this.options.commands.runCommand(action.command, action.args));
      case 'run_tests':
        return commandFeedback(this.feedback, await this.options.commands.runTests());
      case 'remember':
        return { category: 'passed', summary: '本地约定已记录。' };
      case 'finish':
        return { category: 'passed', summary: '任务完成。' };
    }
  }
}

function workspaceFeedback(result: ListWorkspaceResult | ReadWorkspaceResult | WriteWorkspaceResult): DispatcherFeedback {
  if (result.ok) {
    return { category: 'passed', summary: '工作区操作已完成。' };
  }
  return { category: 'command_error', summary: `工作区操作失败（${result.errorCode}）。` };
}

function commandFeedback(summarizer: FeedbackSummarizer, result: CommandResult): DispatcherFeedback {
  return summarizer.summarize({
    exitCode: result.exitCode ?? 1,
    stdout: result.output,
    timedOut: !result.ok && result.timedOut === true
  });
}
