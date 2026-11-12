# Subject card: linear-algebra

- Fix the spaces first: for every map or matrix name the domain, codomain and dimensions, and account for them with rank-nullity.
- Keep the object and its representation apart: a linear map versus its matrix in a basis; a vector versus its coordinates.
- Ask for the geometric picture and the computation both. A learner who can row-reduce but cannot say what the kernel means has not learned it.
- Check answers with invariants (rank, trace, determinant, eigenvalue sum and product) and by multiplying back.
- Typical traps: assuming matrices commute, cancelling a non-invertible matrix, confusing "no solution" with "infinitely many", treating every matrix as diagonalisable.

# Subject card: abstract-algebra

- Start from concrete examples ($\mathbb{Z}_n$, $S_3$, matrices, polynomials) before the axioms, and return to them to test every claim.
- For any structure ask: what is the set, what is the operation, which axioms hold, and which fail?
- For any map ask: is it well defined, is it a homomorphism, what are its kernel and image?
- Require a counterexample when a statement is false, and the exact hypothesis used at each proof step.
- Typical traps: assuming commutativity, skipping "well defined" on quotients, confusing an element's order with the group's order, treating isomorphic as equal.

# Subject card: discrete-maths

- Make the learner test small cases ($n = 0, 1, 2, 3$) before any general claim, and again after it.
- For counting: say what is being counted, whether order matters, whether repetition is allowed, and check the formula against a hand count.
- For induction: state the predicate $P(n)$ exactly, the base case, and where the inductive hypothesis is used.
- For logic and sets: translate between words, symbols and a truth table or Venn picture.
- For graphs and recurrences: draw or unroll a small instance first.
- Typical traps: off-by-one errors, double counting, swapping quantifier order, proving the converse, induction steps that never use the hypothesis.

# Subject card: proofs-problem-solving

- Follow Polya: understand the problem (what is given, what is wanted, restate it), make a plan, carry it out, look back.
- Before helping, ask what the learner has tried and which simpler or related problem they can already solve.
- Heuristics to prompt for: try small cases, draw a figure, work backwards, look for an invariant or symmetry, consider the extreme case, drop a condition.
- In proofs every line needs a reason. Ask "which hypothesis did you use here?" and "where would this fail without it?".
- After a solution ask for a check, a second method, or a generalisation.
- Typical traps: assuming what is to be proved, proving one example instead of the general case, unstated cases, dividing by something that may be zero.

# Subject card: calculus-analysis

- Tie every definition (limit, continuity, derivative, integral, convergence) to a picture and to a numeric example before the formal statement.
- In epsilon-delta work make the learner say what is given, what must be found, and in which order the quantifiers come.
- Check computed results: differentiate an antiderivative, test a limit numerically, check units and limiting cases.
- Ask which theorem licenses each step and whether its hypotheses hold (continuity, differentiability, uniform versus pointwise).
- Typical traps: swapping limits, sums and integrals without justification, treating $dy/dx$ as a fraction where that fails, forgetting the chain rule or the constant of integration, assuming continuous implies differentiable.

# Subject card: probability-statistics

- Always start by naming the sample space, the event and the random variable. Many errors disappear at this step.
- Ask for a sanity check on every answer: is it between 0 and 1, does it match a small enumeration or a quick simulation?
- Keep apart: $P(A \mid B)$ and $P(B \mid A)$; independence and disjointness; a parameter and its estimate; a sample statistic and its distribution.
- For inference, make the learner state the model, the null hypothesis and what the p-value or interval does and does not say.
- Typical traps: base-rate neglect, adding probabilities of overlapping events, assuming independence, reading a confidence interval as a probability statement about the parameter.

# Subject card: code-software-systems

- Teach by prediction: show code or a design and ask what it does, what it prints, or what breaks under load, before explaining.
- Pose the problem before the solution: "requests arrive faster than one machine can serve them; what would you do?" Let the learner derive the design decision, then compare it with the real one and its trade-offs.
- Make the learner trace: one request through the layers, one value through the functions, one failure through the system.
- Ask for the invariant a piece of code maintains, its failure modes, and its cost in time and space.
- Prefer small runnable snippets the learner can execute and change.
- Typical traps: memorised pattern names with no problem attached, ignoring failure and concurrency, confusing interface with implementation.

# Subject card: neural-networks-ai

- Track shapes everywhere. For any layer or operation ask for the input shape, the output shape and the parameter count.
- Make the learner do one forward pass and one backward pass by hand on a tiny network (2 inputs, 2 hidden units) before trusting a framework.
- Connect each idea to the maths under it: a layer is an affine map plus a nonlinearity, backpropagation is the chain rule, training is gradient descent on a loss.
- Ask what would happen if a part were removed or changed: no nonlinearity, a larger learning rate, no normalisation, zero initialisation.
- Keep apart: parameters and hyperparameters, training loss and generalisation, the model and the optimiser.
- Typical traps: shape mismatches, treating backpropagation as magic, reading low training loss as success, confusing attention weights with explanations.

# Subject card: architecture-compilers

- Work at one level at a time and name it: source, syntax tree, intermediate representation, assembly, machine code, microarchitecture.
- Make the learner be the machine: hand-assemble a short instruction, step the registers and memory through a few instructions, walk a stack frame through a call and return.
- Make the learner be the compiler: tokenise and parse a short expression by hand, draw its tree, lower it to three-address code, then to assembly.
- For each stage ask what information it adds, what it throws away, and which errors it can detect.
- For each design choice (RISC versus CISC, calling convention, pipelining, register allocation) pose the constraint first and ask what they would do.
- Typical traps: confusing the instruction set with its implementation, compile time with run time, stack with heap, a value with its address.
