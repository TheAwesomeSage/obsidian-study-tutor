// Labelled checks shared by the browser harness (the real Pyodide worker) and the Node test
// (the same Python, run by a local Python when one with SymPy is installed).

import { Claim } from "../src/sympy";

// [what it is, claim, expected outcome: true = holds, false = does not hold, null = undecided]
export const CASES: [string, Claim, boolean | null][] = [
  ["expanded square", { type: "equal", a: "(x+1)**2", b: "x**2+2*x+1" }, true],
  ["wrong expansion", { type: "equal", a: "(x+1)**2", b: "x**2+1" }, false],
  ["trig identity", { type: "equal", a: "sin(x)**2 + cos(x)**2", b: "1" }, true],
  ["double angle", { type: "equal", a: "sin(2*x)", b: "2*sin(x)*cos(x)" }, true],
  ["half as decimal", { type: "equal", a: "1/2", b: "0.5" }, true],
  ["surd forms", { type: "equal", a: "sqrt(2)/2", b: "1/sqrt(2)" }, true],
  ["log rule", { type: "equal", a: "log(x**2)", b: "2*log(x)" }, true],
  ["determinant", { type: "equal", a: "det(Matrix([[1,2],[3,4]]))", b: "-2" }, true],
  ["matrix product", { type: "equal", a: "Matrix([[1,2],[3,4]])*Matrix([[0,1],[1,0]])", b: "Matrix([[2,1],[4,3]])" }, true],
  ["matrix product wrong", { type: "equal", a: "Matrix([[1,2],[3,4]])*Matrix([[0,1],[1,0]])", b: "Matrix([[1,2],[3,4]])" }, false],
  ["eigenvalue check", { type: "equal", a: "det(Matrix([[2,0],[0,3]]) - 2*eye(2))", b: "0" }, true],
  ["limit", { type: "equal", a: "limit(sin(x)/x, x, 0)", b: "1" }, true],
  ["laplace transform", { type: "equal", a: "laplace_transform(exp(-2*t), t, s, noconds=True)", b: "1/(s+2)" }, true],
  ["complex modulus", { type: "equal", a: "Abs(3+4*I)", b: "5" }, true],
  ["sum of first n integers", { type: "equal", a: "summation(k, (k, 1, n))", b: "n*(n+1)/2" }, true],
  ["derivative right", { type: "derivative", f: "sin(x)**2", var: "x", result: "2*sin(x)*cos(x)" }, true],
  ["derivative right, other form", { type: "derivative", f: "sin(x)**2", var: "x", result: "sin(2*x)" }, true],
  ["derivative wrong", { type: "derivative", f: "sin(x)**2", var: "x", result: "cos(x)**2" }, false],
  ["chain rule", { type: "derivative", f: "exp(3*x**2)", var: "x", result: "6*x*exp(3*x**2)" }, true],
  ["antiderivative", { type: "integral", f: "x*exp(x)", var: "x", result: "(x-1)*exp(x)" }, true],
  ["antiderivative wrong", { type: "integral", f: "x*exp(x)", var: "x", result: "x*exp(x)" }, false],
  ["definite integral", { type: "integral", f: "x**2", var: "x", from: "0", to: "3", result: "9" }, true],
  ["gaussian integral", { type: "integral", f: "exp(-x**2)", var: "x", from: "-oo", to: "oo", result: "sqrt(pi)" }, true],
  ["quadratic roots", { type: "solve", eq: "x**2 - 5*x + 6 = 0", var: "x", solutions: ["2", "3"] }, true],
  ["quadratic, one root missing", { type: "solve", eq: "x**2 - 5*x + 6 = 0", var: "x", solutions: ["2"] }, false],
  ["quadratic, wrong root", { type: "solve", eq: "x**2 - 5*x + 6 = 0", var: "x", solutions: ["2", "4"] }, false],
  ["complex roots", { type: "solve", eq: "x**2 + 1", var: "x", solutions: ["I", "-I"] }, true],
  ["value of sin 60", { type: "value", expr: "sin(pi/3)", value: "0.8660" }, true],
  ["value wrong", { type: "value", expr: "sin(pi/3)", value: "0.5000" }, false],
  ["learner types 2x+1 for 1+2x", { type: "equal", a: "2x+1", b: "1 + 2*x", lenient: true }, true],
  ["learner types e^(2x)", { type: "equal", a: "e^(2x)", b: "exp(2*x)", lenient: true }, true],
  ["learner uses j", { type: "equal", a: "(1+j)(1-j)", b: "2", lenient: true }, true],
  ["learner types xy+yx", { type: "equal", a: "xy + yx", b: "2*x*y", lenient: true }, true],
  ["learner wrong", { type: "equal", a: "2x+2", b: "1 + 2*x", lenient: true }, false],
];

// Strings that must never reach the parser.
export const UNSAFE = ["__import__('os')", "x.__class__", "().__class__.__bases__", "open('a')", "lambda: 1", "exec(1)", "js.fetch(1)", "import os", "x; y", '"a"', "eval(x)", "pyodide.runPython(1)"];

// Answers as they appear in notes or as a learner types them.
export const PLAIN: [string, string | null][] = [
  ["$\\frac{1}{2}$", "((1)/(2))"],
  ["\\sqrt{2}/2", "sqrt(2)/2"],
  ["$2x^{2}+1$", "2x**(2)+1"],
  ["e^{-2t}", "e**(-2t)"],
  ["$\\frac{\\sqrt{3}}{2}$", "((sqrt(3))/(2))"],
  ["3\\pi/4", "3pi/4"],
  ["rank nullity theorem", null],
  ["It contains the zero vector", null],
  ["x = 2", null],
  ["0", "0"],
];


// Typed answers compared with an expected answer, the way quizzes, placement and review do it.
const TYPED: [string, Claim, boolean | null][] = [
  ["decimal for a fraction", { type: "equal", a: "0.333", b: "1/3", lenient: true }, true],
  ["fraction for a decimal", { type: "equal", a: "1/3", b: "0.333", lenient: true }, true],
  ["one decimal place is too few to tell", { type: "equal", a: "0.3", b: "1/3", lenient: true }, null],
  ["wrong decimal", { type: "equal", a: "0.25", b: "1/3", lenient: true }, false],
  ["a different letter is left to the model", { type: "equal", a: "x**2/2 + c", b: "x**2/2 + C", lenient: true }, null],
  ["lamda as a symbol", { type: "equal", a: "lamda^2 - 1", b: "(lamda-1)(lamda+1)", lenient: true }, true],
  ["a unit letter", { type: "equal", a: "5 V", b: "5V", lenient: true }, true],
  ["transfer function, terms reordered", { type: "equal", a: "1/(s+2)", b: "1/(2+s)", lenient: true }, true],
  ["multiple of pi as a decimal", { type: "equal", a: "3pi/4", b: "0.75 pi", lenient: true }, true],
  ["a percent sign cannot be parsed", { type: "equal", a: "50%", b: "0.5", lenient: true }, null],
];
CASES.push(...TYPED);

// What the model writes: functions of a variable, matrix helpers, an eigenvalue symbol.
CASES.push(
  ["characteristic polynomial", { type: "equal", a: "det(Matrix([[2,1],[0,3]]) - lamda*eye(2))", b: "(2-lamda)*(3-lamda)" }, true],
  ["inverse via helper", { type: "equal", a: "inv(Matrix([[1,2],[3,4]]))", b: "Matrix([[-2,1],[3/2,-1/2]])" }, true],
  ["rank via helper", { type: "equal", a: "rank(Matrix([[1,2],[2,4]]))", b: "1" }, true],
  ["inverse laplace", { type: "equal", a: "inverse_laplace_transform(1/(s+2), s, t)", b: "exp(-2*t)*Heaviside(t)" }, true],
  ["a product written without its star", { type: "equal", a: "2x + 3(x+1)", b: "5*x + 3" }, true],
);

// Batches in which later items use earlier results by name. Expected: the printed value of a
// computation, or true / false / null for a check.
export const CHAINS: [string, Claim[], (string | boolean | null)[]][] = [
  [
    "integrate, then solve with the result, then check",
    [
      { type: "compute", expr: "integrate(t*exp(-2*t), (t, 0, oo))", name: "r1" },
      { type: "compute", expr: "solve(s**2 + 3*s + r1, s)", name: "r2" },
      { type: "compute", expr: "r2[0] + r2[1]", name: "r3" },
      { type: "derivative", f: "r1*x**2", var: "x", result: "x/2" },
    ],
    ["1/4", "[-3/2 - sqrt(2), -3/2 + sqrt(2)]", "-3", true],
  ],
  [
    "transfer function to step response",
    [
      { type: "compute", expr: "apart(1/(s*(s+2)), s)", name: "r1" },
      { type: "compute", expr: "inverse_laplace_transform(r1, s, t)", name: "r2" },
      { type: "compute", expr: "limit(r2, t, oo)", name: "r3" },
    ],
    ["-1/(2*(s + 2)) + 1/(2*s)", "Heaviside(t)/2 - exp(-2*t)*Heaviside(t)/2", "1/2"],
  ],
  [
    "a differential equation and a matrix",
    [
      { type: "compute", expr: "dsolve(Derivative(y(x), x, x) + y(x), y(x))", name: "r1" },
      { type: "compute", expr: "eigenvals(Matrix([[2,1],[0,3]]))", name: "r2" },
      { type: "compute", expr: "no_such_function(", name: "r3" },
    ],
    ["Eq(y(x), C1*sin(x) + C2*cos(x))", "{3: 1, 2: 1}", null],
  ],
];
