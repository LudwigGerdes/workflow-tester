import type { INode, INodeExecutionData, IWorkflowDataProxyData } from 'n8n-workflow';
import { semanticsFor } from '../src/semantics/index.js';
import type { SemanticsContext } from '../src/types.js';

export const items = (...jsons: Array<Record<string, unknown>>): INodeExecutionData[] =>
  jsons.map((json, item) => ({ json, pairedItem: { item } }));

/** Drive one node kind's semantics with hand-built resolved parameters. */
export const runSemantics = (
  type: string,
  typeVersion: number,
  params: Record<string, unknown>,
  input: INodeExecutionData[],
) => {
  const semantics = semanticsFor(type, typeVersion);
  if (semantics === undefined) throw new Error(`no semantics for ${type}@${typeVersion}`);
  const node: INode = { parameters: {}, id: 'N', name: 'N', type, typeVersion, position: [0, 0] };
  // A stand-in for n8n's data proxy, carrying only the members a semantics
  // under unit test reads. The real proxy is exercised through `walk` instead,
  // which is where fidelity actually matters.
  const ctx: SemanticsContext = {
    node,
    inputs: [input],
    resolve: () => params,
    dataProxy: (itemIndex: number) =>
      ({
        $input: { all: () => input, first: () => input[0], last: () => input[input.length - 1] },
        $json: input[itemIndex]?.json,
        $node: { name: node.name },
      }) as unknown as IWorkflowDataProxyData,
  };
  return semantics(ctx, input);
};
