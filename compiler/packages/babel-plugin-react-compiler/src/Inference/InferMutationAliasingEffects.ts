/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CompilerError, Effect, ValueKind} from '..';
import {
  BasicBlock,
  BlockId,
  Environment,
  HIRFunction,
  IdentifierId,
  Instruction,
  InstructionValue,
  isArrayType,
  isMapType,
  isSetType,
  Phi,
  Place,
  SpreadPattern,
  ValueReason,
} from '../HIR';
import {
  eachInstructionValueLValue,
  eachInstructionValueOperand,
  eachTerminalSuccessor,
} from '../HIR/visitors';
import {Ok, Result} from '../Utils/Result';
import {
  getFunctionCallSignature,
  isKnownMutableEffect,
  mergeValueKinds,
} from './InferReferenceEffects';
import {
  assertExhaustive,
  getOrInsertWith,
  Set_isSuperset,
} from '../Utils/utils';
import {
  printAliasingEffect,
  printIdentifier,
  printInstruction,
  printInstructionValue,
  printPlace,
  printSourceLocation,
} from '../HIR/PrintHIR';
import {FunctionSignature} from '../HIR/ObjectShape';
import {getWriteErrorReason} from './InferFunctionEffects';
import prettyFormat from 'pretty-format';

export function inferMutationAliasingEffects(
  fn: HIRFunction,
  {isFunctionExpression}: {isFunctionExpression: boolean} = {
    isFunctionExpression: false,
  },
): Result<void, CompilerError> {
  const initialState = InferenceState.empty(fn.env, isFunctionExpression);

  // Map of blocks to the last (merged) incoming state that was processed
  const statesByBlock: Map<BlockId, InferenceState> = new Map();

  for (const ref of fn.context) {
    // TODO: using InstructionValue as a bit of a hack, but it's pragmatic
    const value: InstructionValue = {
      kind: 'ObjectExpression',
      properties: [],
      loc: ref.loc,
    };
    initialState.initialize(value, {
      kind: ValueKind.Context,
      reason: new Set([ValueReason.Other]),
    });
    initialState.define(ref, value);
  }

  const paramKind: AbstractValue = isFunctionExpression
    ? {
        kind: ValueKind.Mutable,
        reason: new Set([ValueReason.Other]),
      }
    : {
        kind: ValueKind.Frozen,
        reason: new Set([ValueReason.ReactiveFunctionArgument]),
      };

  if (fn.fnType === 'Component') {
    CompilerError.invariant(fn.params.length <= 2, {
      reason:
        'Expected React component to have not more than two parameters: one for props and for ref',
      description: null,
      loc: fn.loc,
      suggestions: null,
    });
    const [props, ref] = fn.params;
    if (props != null) {
      inferParam(props, initialState, paramKind);
    }
    if (ref != null) {
      const place = ref.kind === 'Identifier' ? ref : ref.place;
      const value: InstructionValue = {
        kind: 'ObjectExpression',
        properties: [],
        loc: place.loc,
      };
      initialState.initialize(value, {
        kind: ValueKind.Mutable,
        reason: new Set([ValueReason.Other]),
      });
      initialState.define(place, value);
    }
  } else {
    for (const param of fn.params) {
      inferParam(param, initialState, paramKind);
    }
  }

  /*
   * Multiple predecessors may be visited prior to reaching a given successor,
   * so track the list of incoming state for each successor block.
   * These are merged when reaching that block again.
   */
  const queuedStates: Map<BlockId, InferenceState> = new Map();
  function queue(blockId: BlockId, state: InferenceState): void {
    let queuedState = queuedStates.get(blockId);
    if (queuedState != null) {
      // merge the queued states for this block
      state = queuedState.merge(state) ?? queuedState;
      queuedStates.set(blockId, state);
    } else {
      /*
       * this is the first queued state for this block, see whether
       * there are changed relative to the last time it was processed.
       */
      const prevState = statesByBlock.get(blockId);
      const nextState = prevState != null ? prevState.merge(state) : state;
      if (nextState != null) {
        queuedStates.set(blockId, nextState);
      }
    }
  }
  queue(fn.body.entry, initialState);

  const signatureCache: Map<Instruction, InstructionSignature> = new Map();
  const effectInstructionValueCache: Map<AliasingEffect, InstructionValue> =
    new Map();

  let count = 0;
  while (queuedStates.size !== 0) {
    count++;
    if (count > 1000) {
      console.log(
        'oops infinite loop',
        fn.id,
        typeof fn.loc !== 'symbol' ? fn.loc?.filename : null,
      );
      throw new Error('infinite loop');
    }
    for (const [blockId, block] of fn.body.blocks) {
      const incomingState = queuedStates.get(blockId);
      queuedStates.delete(blockId);
      if (incomingState == null) {
        continue;
      }

      statesByBlock.set(blockId, incomingState);
      const state = incomingState.clone();
      inferBlock(state, block, signatureCache, effectInstructionValueCache);

      for (const nextBlockId of eachTerminalSuccessor(block.terminal)) {
        queue(nextBlockId, state);
      }
    }
  }
  return Ok(undefined);
}

function inferParam(
  param: Place | SpreadPattern,
  initialState: InferenceState,
  paramKind: AbstractValue,
): void {
  const place = param.kind === 'Identifier' ? param : param.place;
  const value: InstructionValue = {
    kind: 'Primitive',
    loc: place.loc,
    value: undefined,
  };
  initialState.initialize(value, paramKind);
  initialState.define(place, value);
}

function inferBlock(
  state: InferenceState,
  block: BasicBlock,
  instructionSignatureCache: Map<Instruction, InstructionSignature>,
  effectInstructionValueCache: Map<AliasingEffect, InstructionValue>,
): void {
  for (const phi of block.phis) {
    state.inferPhi(phi);
  }

  for (const instr of block.instructions) {
    let instructionSignature = instructionSignatureCache.get(instr);
    if (instructionSignature == null) {
      instructionSignature = computeSignatureForInstruction(state.env, instr);
      instructionSignatureCache.set(instr, instructionSignature);
    }
    /*
     * console.log(
     *   printInstruction({...instr, effects: [...instructionSignature.effects]}),
     * );
     */
    const effects = applySignature(
      state,
      instructionSignature,
      instr,
      effectInstructionValueCache,
    );
    instr.effects = effects;
  }
}

/**
 * Applies the signature to the given state to determine the precise set of effects
 * that will occur in practice. This takes into account the inferred state of each
 * variable. For example, the signature may have a `ConditionallyMutate x` effect.
 * Here, we check the abstract type of `x` and either record a `Mutate x` if x is mutable
 * or no effect if x is a primitive, global, or frozen.
 *
 * This phase may also emit errors, for example MutateLocal on a frozen value is invalid.
 */
function applySignature(
  state: InferenceState,
  signature: InstructionSignature,
  instruction: Instruction,
  effectInstructionValueCache: Map<AliasingEffect, InstructionValue>,
): Array<AliasingEffect> | null {
  /**
   * For function instructions, eagerly validate that they aren't mutating
   * a known-frozen value.
   *
   * TODO: make sure we're also validating against global mutations somewhere, but
   * account for this being allowed in effects/event handlers.
   */
  if (
    instruction.value.kind === 'FunctionExpression' ||
    instruction.value.kind === 'ObjectMethod'
  ) {
    const aliasingEffects =
      instruction.value.loweredFunc.func.aliasingEffects ?? [];
    for (const effect of aliasingEffects) {
      if (effect.kind === 'Mutate' || effect.kind === 'MutateTransitive') {
        const value = state.kind(effect.value);
        if (value.kind === ValueKind.Frozen) {
          if (DEBUG) {
            console.log(printInstruction(instruction));
            console.log(printAliasingEffect(effect));
            console.log(prettyFormat(state.debugAbstractValue(value)));
          }
          const reason = getWriteErrorReason({
            kind: value.kind,
            reason: value.reason,
            context: new Set(),
          });
          CompilerError.throwInvalidReact({
            reason,
            description:
              effect.value.identifier.name !== null &&
              effect.value.identifier.name.kind === 'named'
                ? `Found mutation of \`${effect.value.identifier.name}\``
                : null,
            loc: effect.value.loc,
            suggestions: null,
          });
        }
      }
    }
  }

  /*
   * Track which values we've already aliased once, so that we can switch to
   * appendAlias() for subsequent aliases into the same value
   */
  const aliased = new Set<IdentifierId>();

  if (DEBUG) {
    console.log(printInstruction(instruction));
  }

  const effects: Array<AliasingEffect> = [];
  for (const effect of signature.effects) {
    applyEffect(
      state,
      effect,
      instruction,
      effectInstructionValueCache,
      aliased,
      effects,
    );
  }
  if (DEBUG) {
    console.log(
      prettyFormat(state.debugAbstractValue(state.kind(instruction.lvalue))),
    );
  }
  if (
    !(state.isDefined(instruction.lvalue) && state.kind(instruction.lvalue))
  ) {
    CompilerError.invariant(false, {
      reason: `Expected instruction lvalue to be initialized`,
      loc: instruction.loc,
    });
  }
  return effects.length !== 0 ? effects : null;
}

function applyEffect(
  state: InferenceState,
  effect: AliasingEffect,
  instruction: Instruction,
  effectInstructionValueCache: Map<AliasingEffect, InstructionValue>,
  aliased: Set<IdentifierId>,
  effects: Array<AliasingEffect>,
): void {
  if (DEBUG) {
    console.log(printAliasingEffect(effect));
  }
  switch (effect.kind) {
    case 'Freeze': {
      const didFreeze = state.freeze(effect.value, effect.reason);
      if (didFreeze) {
        effects.push(effect);
      }
      break;
    }
    case 'Create': {
      let value = effectInstructionValueCache.get(effect);
      if (value == null) {
        value = {
          kind: 'ObjectExpression',
          properties: [],
          loc: effect.into.loc,
        };
        effectInstructionValueCache.set(effect, value);
      }
      state.initialize(value, {
        kind: effect.value,
        reason: new Set([ValueReason.Other]),
      });
      state.define(effect.into, value);
      break;
    }
    case 'ImmutableCapture': {
      const kind = state.kind(effect.from).kind;
      switch (kind) {
        case ValueKind.Global:
        case ValueKind.Primitive: {
          // no-op: we don't need to track data flow for copy types
          break;
        }
        default: {
          effects.push(effect);
        }
      }
      break;
    }
    case 'CreateFrom': {
      const kind = state.kind(effect.from).kind;
      let value = effectInstructionValueCache.get(effect);
      if (value == null) {
        value = {
          kind: 'ObjectExpression',
          properties: [],
          loc: effect.into.loc,
        };
        effectInstructionValueCache.set(effect, value);
      }
      state.initialize(value, {
        kind,
        reason: new Set([ValueReason.Other]),
      });
      state.define(effect.into, value);
      switch (kind) {
        case ValueKind.Primitive:
        case ValueKind.Global: {
          // no need to track this data flow
          break;
        }
        case ValueKind.Frozen: {
          effects.push({
            kind: 'ImmutableCapture',
            from: effect.from,
            into: effect.into,
          });
          break;
        }
        default: {
          // TODO: should this be Alias??
          effects.push({
            kind: 'Capture',
            from: effect.from,
            into: effect.into,
          });
        }
      }
      break;
    }
    case 'Capture': {
      /*
       * Capture describes potential information flow: storing a pointer to one value
       * within another. If the destination is not mutable, or the source value has
       * copy-on-write semantics, then we can prune the effect
       */
      const intoKind = state.kind(effect.into).kind;
      let isMutableDesination: boolean;
      switch (intoKind) {
        case ValueKind.Context:
        case ValueKind.Mutable:
        case ValueKind.MaybeFrozen: {
          isMutableDesination = true;
          break;
        }
        default: {
          isMutableDesination = false;
          break;
        }
      }
      const fromKind = state.kind(effect.from).kind;
      let isMutableReferenceType: boolean;
      switch (fromKind) {
        case ValueKind.Global:
        case ValueKind.Primitive: {
          isMutableReferenceType = false;
          break;
        }
        case ValueKind.Frozen: {
          isMutableReferenceType = false;
          effects.push({
            kind: 'ImmutableCapture',
            from: effect.from,
            into: effect.into,
          });
          break;
        }
        default: {
          isMutableReferenceType = true;
          break;
        }
      }
      if (isMutableDesination && isMutableReferenceType) {
        effects.push(effect);
      }
      break;
    }
    case 'Alias': {
      /*
       * Alias represents potential pointer aliasing. If the type is a global,
       * a primitive (copy-on-write semantics) then we can prune the effect
       */
      const fromKind = state.kind(effect.from).kind;
      switch (fromKind) {
        case ValueKind.Frozen: {
          effects.push({
            kind: 'ImmutableCapture',
            from: effect.from,
            into: effect.into,
          });
          let value = effectInstructionValueCache.get(effect);
          if (value == null) {
            value = {
              kind: 'Primitive',
              value: undefined,
              loc: effect.from.loc,
            };
            effectInstructionValueCache.set(effect, value);
          }
          state.initialize(value, {kind: fromKind, reason: new Set([])});
          state.define(effect.into, value);
          break;
        }
        case ValueKind.Global:
        case ValueKind.Primitive: {
          let value = effectInstructionValueCache.get(effect);
          if (value == null) {
            value = {
              kind: 'Primitive',
              value: undefined,
              loc: effect.from.loc,
            };
            effectInstructionValueCache.set(effect, value);
          }
          state.initialize(value, {kind: fromKind, reason: new Set([])});
          state.define(effect.into, value);
          break;
        }
        default: {
          if (aliased.has(effect.into.identifier.id)) {
            state.appendAlias(effect.into, effect.from);
          } else {
            aliased.add(effect.into.identifier.id);
            state.alias(effect.into, effect.from);
          }
          effects.push(effect);
          break;
        }
      }
      break;
    }
    case 'Apply': {
      const signatureEffects =
        effect.signature?.aliasing != null
          ? computeEffectsForSignature(
              effect.signature.aliasing,
              effect.into,
              effect.receiver,
              effect.args,
            )
          : null;
      if (signatureEffects != null) {
        for (const signatureEffect of signatureEffects) {
          applyEffect(
            state,
            signatureEffect,
            instruction,
            effectInstructionValueCache,
            aliased,
            effects,
          );
        }
      } else if (effect.signature != null) {
        const legacyEffects = computeEffectsForLegacySignature(
          state,
          effect.signature,
          effect.into,
          effect.receiver,
          effect.args,
        );
        for (const legacyEffect of legacyEffects) {
          applyEffect(
            state,
            legacyEffect,
            instruction,
            effectInstructionValueCache,
            aliased,
            effects,
          );
        }
      } else {
        applyEffect(
          state,
          {
            kind: 'Create',
            into: effect.into,
            value: ValueKind.Mutable,
          },
          instruction,
          effectInstructionValueCache,
          aliased,
          effects,
        );
        /*
         * If no signature then by default:
         * - All operands are conditionally mutated, except some instruction
         *   variants are assumed to not mutate the callee (such as `new`)
         * - All operands are captured into (but not directly aliased as)
         *   every other argument.
         */
        for (const arg of [effect.function, ...effect.args]) {
          const operand = arg.kind === 'Identifier' ? arg : arg.place;
          if (operand !== effect.function || effect.mutatesFunction) {
            applyEffect(
              state,
              {
                kind: 'MutateTransitiveConditionally',
                value: operand,
              },
              instruction,
              effectInstructionValueCache,
              aliased,
              effects,
            );
          }
          /*
           * TODO: this should be Alias, since the function could be identity.
           * Ie local mutation of the result could change the input.
           * But if we emit multiple Alias calls, currently the last one will win
           * when we update the inferencestate in applySignature. So we may need to group
           * them here, or coalesce them in applySignature
           *
           * maybe make `from: Place | Array<Place>`
           */
          applyEffect(
            state,
            {kind: 'Capture', from: operand, into: effect.into},
            instruction,
            effectInstructionValueCache,
            aliased,
            effects,
          );
          for (const otherArg of [effect.function, ...effect.args]) {
            const other =
              otherArg.kind === 'Identifier' ? otherArg : otherArg.place;
            if (other === arg) {
              continue;
            }
            applyEffect(
              state,
              {
                kind: 'Capture',
                from: operand,
                into: other,
              },
              instruction,
              effectInstructionValueCache,
              aliased,
              effects,
            );
          }
        }
      }
      break;
    }
    case 'Mutate':
    case 'MutateConditionally':
    case 'MutateTransitive':
    case 'MutateTransitiveConditionally': {
      const mutationKind = state.mutate(effect.kind, effect.value);
      if (mutationKind === 'mutate') {
        effects.push(effect);
      } else if (
        mutationKind !== 'none' &&
        (effect.kind === 'Mutate' || effect.kind === 'MutateTransitive')
      ) {
        const value = state.kind(effect.value);
        if (DEBUG) {
          console.log(printInstruction(instruction));
          console.log(printAliasingEffect(effect));
          console.log(prettyFormat(state.debugAbstractValue(value)));
        }
        const reason = getWriteErrorReason({
          kind: value.kind,
          reason: value.reason,
          context: new Set(),
        });
        CompilerError.throwInvalidReact({
          reason,
          description:
            effect.value.identifier.name !== null &&
            effect.value.identifier.name.kind === 'named'
              ? `Found mutation of \`${effect.value.identifier.name}\``
              : null,
          loc: effect.value.loc,
          suggestions: null,
        });
      }
      break;
    }
    default: {
      assertExhaustive(
        effect,
        `Unexpected effect kind '${(effect as any).kind as any}'`,
      );
    }
  }
}

const DEBUG = false;

class InferenceState {
  env: Environment;
  #isFunctionExpression: boolean;

  // The kind of each value, based on its allocation site
  #values: Map<InstructionValue, AbstractValue>;
  /*
   * The set of values pointed to by each identifier. This is a set
   * to accomodate phi points (where a variable may have different
   * values from different control flow paths).
   */
  #variables: Map<IdentifierId, Set<InstructionValue>>;

  constructor(
    env: Environment,
    isFunctionExpression: boolean,
    values: Map<InstructionValue, AbstractValue>,
    variables: Map<IdentifierId, Set<InstructionValue>>,
  ) {
    this.env = env;
    this.#isFunctionExpression = isFunctionExpression;
    this.#values = values;
    this.#variables = variables;
  }

  static empty(
    env: Environment,
    isFunctionExpression: boolean,
  ): InferenceState {
    return new InferenceState(env, isFunctionExpression, new Map(), new Map());
  }

  get isFunctionExpression(): boolean {
    return this.#isFunctionExpression;
  }

  // (Re)initializes a @param value with its default @param kind.
  initialize(value: InstructionValue, kind: AbstractValue): void {
    CompilerError.invariant(value.kind !== 'LoadLocal', {
      reason:
        '[InferMutationAliasingEffects] Expected all top-level identifiers to be defined as variables, not values',
      description: null,
      loc: value.loc,
      suggestions: null,
    });
    this.#values.set(value, kind);
  }

  values(place: Place): Array<InstructionValue> {
    const values = this.#variables.get(place.identifier.id);
    CompilerError.invariant(values != null, {
      reason: `[InferMutationAliasingEffects] Expected value kind to be initialized`,
      description: `${printPlace(place)}`,
      loc: place.loc,
      suggestions: null,
    });
    return Array.from(values);
  }

  // Lookup the kind of the given @param value.
  kind(place: Place): AbstractValue {
    const values = this.#variables.get(place.identifier.id);
    CompilerError.invariant(values != null, {
      reason: `[InferMutationAliasingEffects] Expected value kind to be initialized`,
      description: `${printPlace(place)}`,
      loc: place.loc,
      suggestions: null,
    });
    let mergedKind: AbstractValue | null = null;
    for (const value of values) {
      const kind = this.#values.get(value)!;
      mergedKind =
        mergedKind !== null ? mergeAbstractValues(mergedKind, kind) : kind;
    }
    CompilerError.invariant(mergedKind !== null, {
      reason: `[InferMutationAliasingEffects] Expected at least one value`,
      description: `No value found at \`${printPlace(place)}\``,
      loc: place.loc,
      suggestions: null,
    });
    return mergedKind;
  }

  // Updates the value at @param place to point to the same value as @param value.
  alias(place: Place, value: Place): void {
    const values = this.#variables.get(value.identifier.id);
    CompilerError.invariant(values != null, {
      reason: `[InferMutationAliasingEffects] Expected value for identifier to be initialized`,
      description: `${printIdentifier(value.identifier)}`,
      loc: value.loc,
      suggestions: null,
    });
    this.#variables.set(place.identifier.id, new Set(values));
  }

  appendAlias(place: Place, value: Place): void {
    const values = this.#variables.get(value.identifier.id);
    CompilerError.invariant(values != null, {
      reason: `[InferMutationAliasingEffects] Expected value for identifier to be initialized`,
      description: `${printIdentifier(value.identifier)}`,
      loc: value.loc,
      suggestions: null,
    });
    const prevValues = this.values(place);
    this.#variables.set(
      place.identifier.id,
      new Set([...prevValues, ...values]),
    );
  }

  // Defines (initializing or updating) a variable with a specific kind of value.
  define(place: Place, value: InstructionValue): void {
    CompilerError.invariant(this.#values.has(value), {
      reason: `[InferMutationAliasingEffects] Expected value to be initialized at '${printSourceLocation(
        value.loc,
      )}'`,
      description: printInstructionValue(value),
      loc: value.loc,
      suggestions: null,
    });
    this.#variables.set(place.identifier.id, new Set([value]));
  }

  isDefined(place: Place): boolean {
    return this.#variables.has(place.identifier.id);
  }

  /**
   * Marks @param place as transitively frozen. Returns true if the value was not
   * already frozen, false if the value is already frozen (or already known immutable).
   */
  freeze(place: Place, reason: ValueReason): boolean {
    const value = this.kind(place);
    switch (value.kind) {
      case ValueKind.Context:
      case ValueKind.Mutable:
      case ValueKind.MaybeFrozen: {
        const values = this.values(place);
        for (const instrValue of values) {
          this.freezeValue(instrValue, reason);
        }
        return true;
      }
      case ValueKind.Frozen:
      case ValueKind.Global:
      case ValueKind.Primitive: {
        return false;
      }
      default: {
        assertExhaustive(
          value.kind,
          `Unexpected value kind '${(value as any).kind}'`,
        );
      }
    }
  }

  freezeValue(value: InstructionValue, reason: ValueReason): void {
    this.#values.set(value, {
      kind: ValueKind.Frozen,
      reason: new Set([reason]),
    });
    if (value.kind === 'FunctionExpression') {
      for (const place of value.loweredFunc.func.context) {
        this.freeze(place, reason);
      }
    }
  }

  mutate(
    variant:
      | 'Mutate'
      | 'MutateConditionally'
      | 'MutateTransitive'
      | 'MutateTransitiveConditionally',
    place: Place,
  ): 'none' | 'mutate' | 'mutate-frozen' | 'mutate-global' {
    // TODO: consider handling of function expressions by looking at their effects
    const kind = this.kind(place).kind;
    switch (variant) {
      case 'MutateConditionally':
      case 'MutateTransitiveConditionally': {
        switch (kind) {
          case ValueKind.Mutable:
          case ValueKind.Context: {
            return 'mutate';
          }
          default: {
            return 'none';
          }
        }
      }
      case 'Mutate':
      case 'MutateTransitive': {
        switch (kind) {
          case ValueKind.Mutable:
          case ValueKind.Context: {
            return 'mutate';
          }
          case ValueKind.Primitive: {
            // technically an error, but it's not React specific
            return 'none';
          }
          case ValueKind.Frozen: {
            return 'mutate-frozen';
          }
          case ValueKind.Global: {
            return 'mutate-global';
          }
          case ValueKind.MaybeFrozen: {
            return 'none';
          }
          default: {
            assertExhaustive(kind, `Unexpected kind ${kind}`);
          }
        }
      }
      default: {
        assertExhaustive(variant, `Unexpected mutation variant ${variant}`);
      }
    }
  }

  /*
   * Combine the contents of @param this and @param other, returning a new
   * instance with the combined changes _if_ there are any changes, or
   * returning null if no changes would occur. Changes include:
   * - new entries in @param other that did not exist in @param this
   * - entries whose values differ in @param this and @param other,
   *    and where joining the values produces a different value than
   *    what was in @param this.
   *
   * Note that values are joined using a lattice operation to ensure
   * termination.
   */
  merge(other: InferenceState): InferenceState | null {
    let nextValues: Map<InstructionValue, AbstractValue> | null = null;
    let nextVariables: Map<IdentifierId, Set<InstructionValue>> | null = null;

    for (const [id, thisValue] of this.#values) {
      const otherValue = other.#values.get(id);
      if (otherValue !== undefined) {
        const mergedValue = mergeAbstractValues(thisValue, otherValue);
        if (mergedValue !== thisValue) {
          nextValues = nextValues ?? new Map(this.#values);
          nextValues.set(id, mergedValue);
        }
      }
    }
    for (const [id, otherValue] of other.#values) {
      if (this.#values.has(id)) {
        // merged above
        continue;
      }
      nextValues = nextValues ?? new Map(this.#values);
      nextValues.set(id, otherValue);
    }

    for (const [id, thisValues] of this.#variables) {
      const otherValues = other.#variables.get(id);
      if (otherValues !== undefined) {
        let mergedValues: Set<InstructionValue> | null = null;
        for (const otherValue of otherValues) {
          if (!thisValues.has(otherValue)) {
            mergedValues = mergedValues ?? new Set(thisValues);
            mergedValues.add(otherValue);
          }
        }
        if (mergedValues !== null) {
          nextVariables = nextVariables ?? new Map(this.#variables);
          nextVariables.set(id, mergedValues);
        }
      }
    }
    for (const [id, otherValues] of other.#variables) {
      if (this.#variables.has(id)) {
        continue;
      }
      nextVariables = nextVariables ?? new Map(this.#variables);
      nextVariables.set(id, new Set(otherValues));
    }

    if (nextVariables === null && nextValues === null) {
      return null;
    } else {
      return new InferenceState(
        this.env,
        this.#isFunctionExpression,
        nextValues ?? new Map(this.#values),
        nextVariables ?? new Map(this.#variables),
      );
    }
  }

  /*
   * Returns a copy of this state.
   * TODO: consider using persistent data structures to make
   * clone cheaper.
   */
  clone(): InferenceState {
    return new InferenceState(
      this.env,
      this.#isFunctionExpression,
      new Map(this.#values),
      new Map(this.#variables),
    );
  }

  /*
   * For debugging purposes, dumps the state to a plain
   * object so that it can printed as JSON.
   */
  debug(): any {
    const result: any = {values: {}, variables: {}};
    const objects: Map<InstructionValue, number> = new Map();
    function identify(value: InstructionValue): number {
      let id = objects.get(value);
      if (id == null) {
        id = objects.size;
        objects.set(value, id);
      }
      return id;
    }
    for (const [value, kind] of this.#values) {
      const id = identify(value);
      result.values[id] = {
        abstract: this.debugAbstractValue(kind),
        value: printInstructionValue(value),
      };
    }
    for (const [variable, values] of this.#variables) {
      result.variables[`$${variable}`] = [...values].map(identify);
    }
    return result;
  }

  debugAbstractValue(value: AbstractValue): any {
    return {
      kind: value.kind,
      reason: [...value.reason],
    };
  }

  inferPhi(phi: Phi): void {
    const values: Set<InstructionValue> = new Set();
    for (const [_, operand] of phi.operands) {
      const operandValues = this.#variables.get(operand.identifier.id);
      // This is a backedge that will be handled later by State.merge
      if (operandValues === undefined) continue;
      for (const v of operandValues) {
        values.add(v);
      }
    }

    if (values.size > 0) {
      this.#variables.set(phi.place.identifier.id, values);
    }
  }
}

/**
 * Returns a value that represents the combined states of the two input values.
 * If the two values are semantically equivalent, it returns the first argument.
 */
function mergeAbstractValues(
  a: AbstractValue,
  b: AbstractValue,
): AbstractValue {
  const kind = mergeValueKinds(a.kind, b.kind);
  if (
    kind === a.kind &&
    kind === b.kind &&
    Set_isSuperset(a.reason, b.reason)
  ) {
    return a;
  }
  const reason = new Set(a.reason);
  for (const r of b.reason) {
    reason.add(r);
  }
  return {kind, reason};
}

type InstructionSignature = {
  effects: ReadonlyArray<AliasingEffect>;
};

/**
 * Computes an effect signature for the instruction _without_ looking at the inference state,
 * and only using the semantics of the instructions and the inferred types. The idea is to make
 * it easy to check that the semantics of each instruction are preserved by describing only the
 * effects and not making decisions based on the inference state.
 *
 * Then in applySignature(), above, we refine this signature based on the inference state.
 *
 * NOTE: this function is designed to be cached so it's only computed once upon first visiting
 * an instruction.
 */
function computeSignatureForInstruction(
  env: Environment,
  instr: Instruction,
): InstructionSignature {
  const {lvalue, value} = instr;
  const effects: Array<AliasingEffect> = [];
  switch (value.kind) {
    case 'ArrayExpression': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Mutable,
      });
      // All elements are captured into part of the output value
      for (const element of value.elements) {
        if (element.kind === 'Identifier') {
          effects.push({
            kind: 'Capture',
            from: element,
            into: lvalue,
          });
        } else if (element.kind === 'Spread') {
          effects.push({
            kind: 'Capture',
            from: element.place,
            into: lvalue,
          });
        } else {
          continue;
        }
      }
      break;
    }
    case 'ObjectExpression': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Mutable,
      });
      for (const property of value.properties) {
        if (property.kind === 'ObjectProperty') {
          effects.push({
            kind: 'Capture',
            from: property.place,
            into: lvalue,
          });
        } else {
          effects.push({
            kind: 'Capture',
            from: property.place,
            into: lvalue,
          });
        }
      }
      break;
    }
    case 'Await': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Mutable,
      });
      // Potentially mutates the receiver (awaiting it changes its state and can run side effects)
      effects.push({kind: 'MutateTransitiveConditionally', value: value.value});
      /**
       * Data from the promise may be returned into the result, but await does not directly return
       * the promise itself
       */
      effects.push({
        kind: 'Capture',
        from: value.value,
        into: lvalue,
      });
      break;
    }
    case 'NewExpression':
    case 'CallExpression':
    case 'MethodCall': {
      let callee;
      let receiver;
      let mutatesCallee;
      if (value.kind === 'NewExpression') {
        callee = value.callee;
        receiver = value.callee;
        mutatesCallee = false;
      } else if (value.kind === 'CallExpression') {
        callee = value.callee;
        receiver = value.callee;
        mutatesCallee = true;
      } else if (value.kind === 'MethodCall') {
        callee = value.property;
        receiver = value.receiver;
        mutatesCallee = false;
      } else {
        assertExhaustive(
          value,
          `Unexpected value kind '${(value as any).kind}'`,
        );
      }
      const signature = getFunctionCallSignature(env, callee.identifier.type);
      effects.push({
        kind: 'Apply',
        receiver,
        function: callee,
        mutatesFunction: mutatesCallee,
        args: value.args,
        into: lvalue,
        signature,
      });
      break;
    }
    case 'PropertyDelete':
    case 'ComputedDelete': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Primitive,
      });
      // Mutates the object by removing the property, no aliasing
      effects.push({kind: 'Mutate', value: value.object});
      break;
    }
    case 'PropertyLoad':
    case 'ComputedLoad': {
      effects.push({
        kind: 'CreateFrom',
        from: value.object,
        into: lvalue,
      });
      break;
    }
    case 'PropertyStore':
    case 'ComputedStore': {
      effects.push({kind: 'Mutate', value: value.object});
      effects.push({
        kind: 'Capture',
        from: value.value,
        into: value.object,
      });
      effects.push({kind: 'Alias', from: value.value, into: lvalue});
      break;
    }
    case 'PostfixUpdate':
    case 'PrefixUpdate': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Primitive,
      });
      CompilerError.throwTodo({
        reason: `Handle ${value.kind} in new inference`,
        loc: instr.loc,
      });
    }
    case 'ObjectMethod':
    case 'FunctionExpression': {
      /*
       * We consider the function frozen if it has no potential mutations of its context
       * variables.
       * TODO: this may lose some precision relative to InferReferenceEffects, where we
       * decide the valuekind of the function based on the actual state of the context
       * vars. Maybe a `CreateFunction captures=[...] into=place` effect or similar to
       * express the logic
       */
      const kind = value.loweredFunc.func.context.some(
        operand => operand.effect === Effect.Capture,
      )
        ? ValueKind.Mutable
        : ValueKind.Frozen;
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: kind,
      });
      /**
       * We've already analyzed the function expression in AnalyzeFunctions. There, we assign
       * a Capture effect to any context variable that appears (locally) to be aliased and/or
       * mutated. The precise effects are annotated on the function expression's aliasingEffects
       * property, but we don't want to execute those effects yet. We can only use those when
       * we know exactly how the function is invoked — via an Apply effect from a custom signature.
       *
       * But in the general case, functions can be passed around and possibly called in ways where
       * we don't know how to interpret their precise effects. For example:
       *
       * ```
       * const a = {};
       *
       * // We don't want to consider a as mutating here, this just declares the function
       * const f = () => { maybeMutate(a) };
       *
       * // We don't want to consider a as mutating here either, it can't possibly call f yet
       * const x = [f];
       *
       * // Here we have to assume that f can be called (transitively), and have to consider a
       * // as mutating
       * callAllFunctionInArray(x);
       * ```
       *
       * So for any context variables that were inferred as captured or mutated, we record a
       * Capture effect. If the resulting function is transitively mutated, this will mean
       * that those operands are also considered mutated. If the function is never called,
       * they won't be!
       *
       * This relies on the rule that:
       * Capture a -> b and MutateTransitive(b) => Mutate(a)
       *
       * Substituting:
       * Capture contextvar -> function and MutateTransitive(function) => Mutate(contextvar)
       *
       * Note that if the type of the context variables are frozen, global, or primitive, the
       * Capture will either get pruned or downgraded to an ImmutableCapture.
       */
      for (const operand of value.loweredFunc.func.context) {
        if (operand.effect === Effect.Capture) {
          effects.push({
            kind: 'Capture',
            from: operand,
            into: lvalue,
          });
        }
      }
      break;
    }
    case 'GetIterator': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Mutable,
      });
      if (
        isArrayType(value.collection.identifier) ||
        isMapType(value.collection.identifier) ||
        isSetType(value.collection.identifier)
      ) {
        /*
         * Builtin collections are known to return a fresh iterator on each call,
         * so the iterator does not alias the collection
         */
        effects.push({
          kind: 'Capture',
          from: value.collection,
          into: lvalue,
        });
      } else {
        /*
         * Otherwise, the object may return itself as the iterator, so we have to
         * assume that the result directly aliases the collection. Further, the
         * method to get the iterator could potentially mutate the collection
         */
        effects.push({kind: 'Alias', from: value.collection, into: lvalue});
        effects.push({
          kind: 'MutateTransitiveConditionally',
          value: value.collection,
        });
      }
      break;
    }
    case 'IteratorNext': {
      /*
       * Technically advancing an iterator will always mutate it (for any reasonable implementation)
       * But because we create an alias from the collection to the iterator if we don't know the type,
       * then it's possible the iterator is aliased to a frozen value and we wouldn't want to error.
       * so we mark this as conditional mutation to allow iterating frozen values.
       */
      effects.push({kind: 'MutateConditionally', value: value.iterator});
      // Extracts part of the original collection into the result
      effects.push({
        kind: 'CreateFrom',
        from: value.iterator,
        into: lvalue,
      });
      break;
    }
    case 'NextPropertyOf': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Primitive,
      });
      break;
    }
    case 'JsxExpression':
    case 'JsxFragment': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Frozen,
      });
      for (const operand of eachInstructionValueOperand(value)) {
        effects.push({
          kind: 'Freeze',
          value: operand,
          reason: ValueReason.JsxCaptured,
        });
        effects.push({
          kind: 'Capture',
          from: operand,
          into: lvalue,
        });
      }
      break;
    }
    case 'DeclareContext':
    case 'DeclareLocal': {
      // TODO check this
      effects.push({
        kind: 'Create',
        into: value.lvalue.place,
        // TODO: what kind here???
        value: ValueKind.Primitive,
      });
      effects.push({
        kind: 'Create',
        into: lvalue,
        // TODO: what kind here???
        value: ValueKind.Primitive,
      });
      break;
    }
    case 'Destructure': {
      for (const patternLValue of eachInstructionValueLValue(value)) {
        effects.push({
          kind: 'CreateFrom',
          from: value.value,
          into: patternLValue,
        });
      }
      effects.push({kind: 'Alias', from: value.value, into: lvalue});
      break;
    }
    case 'LoadContext': {
      effects.push({kind: 'Alias', from: value.place, into: lvalue});
      break;
    }
    case 'StoreContext': {
      effects.push({kind: 'Mutate', value: value.lvalue.place});
      effects.push({
        kind: 'Alias',
        from: value.value,
        into: value.lvalue.place,
      });
      effects.push({kind: 'Alias', from: value.value, into: lvalue});
      break;
    }
    case 'LoadLocal': {
      effects.push({kind: 'Alias', from: value.place, into: lvalue});
      break;
    }
    case 'StoreLocal': {
      effects.push({
        kind: 'Alias',
        from: value.value,
        into: value.lvalue.place,
      });
      effects.push({kind: 'Alias', from: value.value, into: lvalue});
      break;
    }
    case 'StoreGlobal': {
      CompilerError.throwTodo({
        reason: `Handle StoreGlobal in new inference`,
        loc: instr.loc,
      });
    }
    case 'TypeCastExpression': {
      effects.push({kind: 'Alias', from: value.value, into: lvalue});
      break;
    }
    case 'LoadGlobal': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Global,
      });
      break;
    }
    case 'TaggedTemplateExpression':
    case 'BinaryExpression':
    case 'Debugger':
    case 'FinishMemoize':
    case 'JSXText':
    case 'MetaProperty':
    case 'Primitive':
    case 'RegExpLiteral':
    case 'StartMemoize':
    case 'TemplateLiteral':
    case 'UnaryExpression':
    case 'UnsupportedNode': {
      effects.push({
        kind: 'Create',
        into: lvalue,
        value: ValueKind.Primitive,
      });
      break;
    }
  }
  return {
    effects,
  };
}

/**
 * Creates a set of aliasing effects given a legacy FunctionSignature. This makes all of the
 * old implicit behaviors from the signatures and InferReferenceEffects explicit, see comments
 * in the body for details.
 *
 * The goal of this method is to make it easier to migrate incrementally to the new system,
 * so we don't have to immediately write new signatures for all the methods to get expected
 * compilation output.
 */
function computeEffectsForLegacySignature(
  state: InferenceState,
  signature: FunctionSignature,
  lvalue: Place,
  receiver: Place,
  args: Array<Place | SpreadPattern>,
): Array<AliasingEffect> {
  const effects: Array<AliasingEffect> = [];
  effects.push({
    kind: 'Create',
    into: lvalue,
    value: signature.returnValueKind,
  });
  const stores: Array<Place> = [];
  const captures: Array<Place> = [];
  const returnValueReason =
    signature.returnValueReason ?? ValueReason.KnownReturnSignature;
  function visit(place: Place, effect: Effect): void {
    switch (effect) {
      case Effect.Store: {
        effects.push({
          kind: 'Mutate',
          value: place,
        });
        stores.push(place);
        break;
      }
      case Effect.Capture: {
        captures.push(place);
        break;
      }
      case Effect.ConditionallyMutate: {
        effects.push({
          kind: 'MutateTransitiveConditionally',
          value: place,
        });
        break;
      }
      case Effect.ConditionallyMutateIterator: {
        effects.push({
          kind: 'Capture',
          from: place,
          into: lvalue,
        });
        effects.push({
          kind: 'MutateTransitiveConditionally',
          value: place,
        });
        break;
      }
      case Effect.Freeze: {
        effects.push({
          kind: 'Freeze',
          value: place,
          reason: returnValueReason,
        });
        break;
      }
      case Effect.Mutate: {
        effects.push({kind: 'MutateTransitive', value: place});
        break;
      }
      case Effect.Read: {
        effects.push({
          kind: 'ImmutableCapture',
          from: place,
          into: lvalue,
        });
        break;
      }
    }
  }

  if (
    signature.mutableOnlyIfOperandsAreMutable &&
    areArgumentsImmutableAndNonMutating(state, args)
  ) {
    effects.push({
      kind: 'Capture',
      from: receiver,
      into: lvalue,
    });
    for (const arg of args) {
      const place = arg.kind === 'Identifier' ? arg : arg.place;
      effects.push({
        kind: 'ImmutableCapture',
        from: place,
        into: lvalue,
      });
    }
    return effects;
  }

  if (signature.calleeEffect !== Effect.Capture) {
    /*
     * InferReferenceEffects and FunctionSignature have an implicit assumption that the receiver
     * is captured into the return value. Consider for example the signature for Array.proto.pop:
     * the calleeEffect is Store, since it's a known mutation but non-transitive. But the return
     * of the pop() captures from the receiver! This isn't specified explicitly. So we add this
     * here, and rely on applySignature() to downgrade this to ImmutableCapture (or prune) if
     * the type doesn't actually need to be captured based on the input and return type.
     */
    effects.push({
      kind: 'Capture',
      from: receiver,
      into: lvalue,
    });
  }
  visit(receiver, signature.calleeEffect);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const place = arg.kind === 'Identifier' ? arg : arg.place;
    const effect =
      arg.kind === 'Identifier' && i < signature.positionalParams.length
        ? signature.positionalParams[i]!
        : (signature.restParam ?? Effect.ConditionallyMutate);
    visit(place, effect);
  }
  if (captures.length !== 0) {
    if (stores.length === 0) {
      // If no stores, then capture into the return value
      for (const capture of captures) {
        effects.push({kind: 'Capture', from: capture, into: lvalue});
      }
    } else {
      // Else capture into the stores
      for (const capture of captures) {
        for (const store of stores) {
          effects.push({kind: 'Capture', from: capture, into: store});
        }
      }
    }
  }
  return effects;
}

/**
 * Returns true if all of the arguments are both non-mutable (immutable or frozen)
 * _and_ are not functions which might mutate their arguments. Note that function
 * expressions count as frozen so long as they do not mutate free variables: this
 * function checks that such functions also don't mutate their inputs.
 */
function areArgumentsImmutableAndNonMutating(
  state: InferenceState,
  args: Array<Place | SpreadPattern>,
): boolean {
  for (const arg of args) {
    if (arg.kind === 'Identifier' && arg.identifier.type.kind === 'Function') {
      const fnShape = state.env.getFunctionSignature(arg.identifier.type);
      if (fnShape != null) {
        return (
          !fnShape.positionalParams.some(isKnownMutableEffect) &&
          (fnShape.restParam == null ||
            !isKnownMutableEffect(fnShape.restParam))
        );
      }
    }
    const place = arg.kind === 'Identifier' ? arg : arg.place;

    const kind = state.kind(place).kind;
    switch (kind) {
      case ValueKind.Primitive:
      case ValueKind.Frozen: {
        /*
         * Only immutable values, or frozen lambdas are allowed.
         * A lambda may appear frozen even if it may mutate its inputs,
         * so we have a second check even for frozen value types
         */
        break;
      }
      default: {
        /**
         * Globals, module locals, and other locally defined functions may
         * mutate their arguments.
         */
        return false;
      }
    }
    const values = state.values(place);
    for (const value of values) {
      if (
        value.kind === 'FunctionExpression' &&
        value.loweredFunc.func.params.some(param => {
          const place = param.kind === 'Identifier' ? param : param.place;
          const range = place.identifier.mutableRange;
          return range.end > range.start + 1;
        })
      ) {
        // This is a function which may mutate its inputs
        return false;
      }
    }
  }
  return true;
}

function computeEffectsForSignature(
  signature: AliasingSignature,
  lvalue: Place,
  receiver: Place,
  args: Array<Place | SpreadPattern>,
): Array<AliasingEffect> | null {
  if (
    // Not enough args
    signature.params.length > args.length ||
    // Too many args and there is no rest param to hold them
    (args.length > signature.params.length && signature.rest == null)
  ) {
    return null;
  }
  // Build substitutions
  const substitutions: Map<IdentifierId, Array<Place>> = new Map();
  substitutions.set(signature.receiver, [receiver]);
  substitutions.set(signature.returns, [lvalue]);
  const params = signature.params;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (params == null || i >= params.length || arg.kind === 'Spread') {
      if (signature.rest == null) {
        return null;
      }
      const place = arg.kind === 'Identifier' ? arg : arg.place;
      getOrInsertWith(substitutions, signature.rest, () => []).push(place);
    } else {
      const param = params[i];
      substitutions.set(param, [arg]);
    }
  }

  // Apply substitutions
  const effects: Array<AliasingEffect> = [];
  for (const effect of signature.effects) {
    switch (effect.kind) {
      case 'ImmutableCapture':
      case 'Alias':
      case 'CreateFrom':
      case 'Capture': {
        const from = substitutions.get(effect.from.identifier.id) ?? [];
        const to = substitutions.get(effect.into.identifier.id) ?? [];
        for (const fromId of from) {
          for (const toId of to) {
            effects.push({
              kind: effect.kind,
              from: fromId,
              into: toId,
            });
          }
        }
        break;
      }
      case 'Mutate':
      case 'MutateTransitive':
      case 'MutateTransitiveConditionally':
      case 'MutateConditionally': {
        const values = substitutions.get(effect.value.identifier.id) ?? [];
        for (const id of values) {
          effects.push({kind: effect.kind, value: id});
        }
        break;
      }
      case 'Freeze': {
        const values = substitutions.get(effect.value.identifier.id) ?? [];
        for (const value of values) {
          effects.push({kind: 'Freeze', value, reason: effect.reason});
        }
        break;
      }
      case 'Create': {
        const into = substitutions.get(effect.into.identifier.id) ?? [];
        for (const value of into) {
          effects.push({kind: 'Create', into: value, value: effect.value});
        }
        break;
      }
      case 'Apply': {
        CompilerError.throwTodo({
          reason: `Handle ${effect.kind} effects for function declarations`,
          loc: lvalue.loc,
        });
      }
      default: {
        assertExhaustive(
          effect,
          `Unexpected effect kind '${(effect as any).kind}'`,
        );
      }
    }
  }
  return effects;
}

/*
 * array.map(cb)
 * t3 = t0 .t1 ( t2 )
 * `t3 = MethodCall t0 . t1 ( t2 )
 *
 * ## Signature
 *
 * substitutions: [
 *   @Receiver is t0
 *   @Property is t1
 *   @Callback is t2
 *   @Return is return
 *   @Item is ( t0 as Array ) . Item
 *   @FunctionItem is (t2 as Function) . Params[0]
 *   @FunctionCollection is (t2 as Function) . Params[2]
 *   @FunctionReturn is (t2 as Function) . Return
 * ]
 * effects: [
 *  Capture @Item => @FunctionItem
 *  Capture @Receiver => @FunctionCollection
 *  Mutate? @Callback
 *  Capture @FunctionReturn => @Return
 * ]
 * returns: @Return as Array elements=@FunctionItem
 *
 * ## Example values
 * t0 = @0 Array elements=@0.items
 * t1 = @1
 * t2 = @2 Function (f0, f1, f2) => fret
 *  Capture f0 => fret
 *  Mutate f2
 *
 * apply substitutions and effects:
 *   Capture @Item => @functionItem
 *     => Capture @0.items => f0
 *   Capture @Receiver => @FunctionCollection
 *     => Capture @0 => f2
 *   Mutate? @Callback
 *     => (apply function effects) =>
 *     Capture f0 => fret
 *       => Capture @0.items => fret
 *     Mutate f2
 *       => Mutate @0
 *   Capture @FunctionReturn => @Return
 *     => Capture fret => return
 */

/**
 * Another take
 *
 * Simplify the representation. We don't need to track which entities store which other entities.
 * We can consolidate aliasing/capturing down to 2 things: "aliasing a->b means mutate(b) => mutate(a)" and "capturing a->b means mutate(b) != mutate(a)".
 * For either, we say that "aliasing/capturing a->b implies transitiveMutate(b) => mutate(a)".
 *
 * This simplifies at the expense of needing a second InferMutableRanges style pass after. This is because if we capture out of a larger object and then mutate
 * the captured bit, that still needs to count as a mutation of the larger object:
 * `x = y.z` is "alias y->x", since mutate(x) mutates y.
 *
 * We already have a second pass, so it's not a great loss to have to keep it.
 *
 * Then there is the question of function expressions. In general I think we say that function expression effects happen _on consumption of the function_,
 * (not simple aliasing), unless it's used where we have type information to provide specific information about how the function is called (eg Array.prototype.map).
 *
 *
 * Apply t2 receiver=alias t2, params=[capture t2, alias t2] return=t3
 *
 * Note that we say if each argument is capture or alias. The function declaration may say that it aliases the param 0 into the return, but if we've passed
 * a capture variable that gets translated, e.g. `capture x -> alias y` translates to `capture x -> y`.
 *
 * alias (capture x) -> y   ==> capture x -> y
 * capture (alias x) -> Y   ==> capture x -> y
 * alias (alias x) -> y     ==> alias x -> y
 * capture (capture x) -> y ==> capture x -> y
 *
 * We could then extend this to explicitly represent captured values within each abstract value. Maybe replacing context values.
 */

export type AliasedPlace = {place: Place; kind: 'alias' | 'capture'};

export type AliasingEffect =
  /**
   * Marks the given value, its aliases, and indirect captures, as frozen.
   */
  | {kind: 'Freeze'; value: Place; reason: ValueReason}
  /**
   * Mutate the value and any direct aliases (not captures). Errors if the value is not mutable.
   */
  | {kind: 'Mutate'; value: Place}
  /**
   * Mutate the value and any direct aliases (not captures), but only if the value is known mutable.
   * This should be rare.
   *
   * TODO: this is only used for IteratorNext, but even then MutateTransitiveConditionally is more
   * correct for iterators of unknown types.
   */
  | {kind: 'MutateConditionally'; value: Place}
  /**
   * Mutate the value, any direct aliases, and any transitive captures. Errors if the value is not mutable.
   */
  | {kind: 'MutateTransitive'; value: Place}
  /**
   * Mutates any of the value, its direct aliases, and its transitive captures that are mutable.
   */
  | {kind: 'MutateTransitiveConditionally'; value: Place}
  /**
   * Records indirect aliasing from flow from `from` to `into`. Local mutation (Mutate vs MutateTransitive)
   * of `into` will *not* affect `from`.
   *
   * Example: `x[0] = y[1]`. Information from y (from) is aliased into x (into), but there is not a
   * direct aliasing of y as x.
   */
  | {kind: 'Capture'; from: Place; into: Place}
  /**
   * Records direct aliasing of `from` as `into`. Local mutation (Mutate vs MutateTransitive)
   * of `into` *will* affect `from`.
   */
  | {kind: 'Alias'; from: Place; into: Place}
  /**
   * Creates a value of the given type at the given place
   */
  | {kind: 'Create'; into: Place; value: ValueKind}
  /**
   * Creates a new value with the same kind as the starting value.
   */
  | {kind: 'CreateFrom'; from: Place; into: Place}
  /**
   * Immutable data flow, used for escape analysis. Does not influence mutable range analysis:
   */
  | {kind: 'ImmutableCapture'; from: Place; into: Place}
  /**
   * Calls the function at the given place with the given arguments either captured or aliased,
   * and captures/aliases the result into the given place.
   */
  | {
      kind: 'Apply';
      receiver: Place;
      function: Place;
      mutatesFunction: boolean;
      args: Array<Place | SpreadPattern>;
      into: Place;
      signature: FunctionSignature | null;
    };

export type AliasingSignature = {
  receiver: IdentifierId;
  params: Array<IdentifierId>;
  rest: IdentifierId | null;
  returns: IdentifierId;
  effects: Array<AliasingEffect>;
};

export type AbstractValue = {
  kind: ValueKind;
  reason: ReadonlySet<ValueReason>;
};
