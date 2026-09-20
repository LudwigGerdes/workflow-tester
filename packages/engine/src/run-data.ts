import type {
  IExecuteData,
  INode,
  INodeExecutionData,
  IRunExecutionData,
  ISourceData,
  ITaskData,
} from 'n8n-workflow';
import { createRunExecutionData } from './n8n.js';

/**
 * A synthetic `IRunExecutionData`, built up node by node as the walk proceeds.
 *
 * This is what makes `$('Node')`, `$items()` and paired-item lookups resolve:
 * n8n's data proxy reads the run data of already-executed nodes, so the engine
 * has to record outputs in exactly the shape a real execution would.
 */
export class RunData {
  /** Built through n8n's factory — `IRunExecutionData` is branded against manual construction. */
  readonly data: IRunExecutionData = createRunExecutionData();

  private readonly outputs = new Map<string, INodeExecutionData[][]>();
  private executionIndex = 0;

  /** Record `node`'s per-output-index items, as one successful task run. */
  setOutputs(
    node: string,
    outputs: INodeExecutionData[][],
    source?: { previousNode: string; previousNodeOutput?: number },
  ): void {
    this.outputs.set(node, outputs);
    const task: ITaskData = {
      startTime: 0,
      executionIndex: this.executionIndex++,
      executionTime: 0,
      executionStatus: 'success',
      source: [source ?? null],
      data: { main: outputs },
    };
    this.data.resultData.runData[node] = [task];
    this.data.resultData.lastNodeExecuted = node;
  }

  outputsOf(node: string): INodeExecutionData[][] | undefined {
    return this.outputs.get(node);
  }

  /** The `IExecuteData` n8n's evaluator wants for the node currently being resolved. */
  executeDataFor(
    node: INode,
    input: INodeExecutionData[],
    source: ISourceData | null,
  ): IExecuteData {
    return {
      data: { main: [input] },
      node,
      source: source === null ? null : { main: [source] },
    };
  }
}
