# Signals and systems

## Overview

How a linear time-invariant system responds to an input, worked through the first-order RC low-pass filter: impulse and step responses, the Laplace transform and transfer functions, and what the time constant means for a real circuit. This is an example course that ships with Study Tutor. It was written by hand, not compiled from your notes, and cites no notes in your vault.

The plotting part opens the function plotter that comes with the plugin. Expressions are checked by SymPy when **Compute and check maths with SymPy** is on; without it, they are judged by a model and the record says so. A verified expression is never taken as a sound derivation: the derivation and what it means physically are judged separately.

## Outcome

Predict, plot and derive the step response of a first-order RC low-pass filter, and explain why a real circuit's response differs from the model.

Done well when:
- Predicts the initial value, final value and the value one time constant in
- Reads the initial slope of the response and relates it to the time constant
- Derives the response with the Laplace transform and partial fractions
- Keeps a verified final expression apart from a sound derivation
- Gives physical reasons a measured response departs from the ideal model

## Subskills

### 1. LTI systems and their responses
prerequisites: none
- A system is linear when scaling and adding inputs scales and adds the outputs, and time-invariant when delaying the input only delays the output.
- An LTI system is described completely by its impulse response h(t): the output for any input is the convolution of the input with h(t).
- The step response is the running integral of the impulse response, because the step is the running integral of the impulse.
misconceptions:
- any system with a formula is linear
- the step response and the impulse response are unrelated
worked example:
For h(t) = e^{−t} for t ≥ 0, the step response is the integral of e^{−τ} from 0 to t, which is 1 − e^{−t} for t ≥ 0.

### 2. Laplace transforms and transfer functions
prerequisites: 1
- The Laplace transform turns convolution in time into multiplication in s: Y(s) = H(s) X(s), where H(s) is the transfer function.
- The unit step transforms to 1/s, and e^{−at} for t ≥ 0 transforms to 1/(s + a).
- The inverse transform of a rational Y(s) comes from partial fractions and a table of pairs.
- The RC low-pass filter has H(s) = 1/(1 + sRC).
misconceptions:
- the inverse transform of a product is the product of the inverse transforms
- a final expression that checks out proves the working that led to it
worked example:
With RC = 1 s and a unit step in, V(s) = 1/(s(s + 1)) = 1/s − 1/(s + 1), so v(t) = 1 − e^{−t} for t ≥ 0.

### 3. First-order systems and the time constant
prerequisites: 1, 2
structure: first-order-decay
- The step response of a first-order low-pass filter is v(t) = 1 − e^{−t/τ} for t ≥ 0, with τ = RC.
- It starts at 0, rises with initial slope 1/τ, reaches about 63% at t = τ and about 95% at t = 3τ, and settles at the input's level.
- The cutoff frequency is ω_c = 1/τ rad/s, where the gain has fallen to 1/√2.
- A real circuit departs from the model. A capacitor or resistor above its marked value, or extra resistance in series (the source's output resistance, the wiring), lengthens the time constant. A resistive load across the output, or capacitor leakage, shortens it and lowers the final value. A scope probe's few picofarads are negligible next to a large capacitor.
misconceptions:
- the response reaches its final value after one time constant
- a measured time constant that differs from RC means the theory is wrong
worked example:
R = 1 kΩ and C = 1 mF give τ = 1 s. After 1 s the output is 1 − e^{−1} ≈ 0.63 of the step, and the initial slope is 1/τ = 1 per second.
