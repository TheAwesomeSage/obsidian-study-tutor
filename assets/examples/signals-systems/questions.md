### Q1
subskill: 1
type: mcq
question: For a linear time-invariant system, which single response is enough to work out its output for any input?
options:
- A. The response to a sine wave at one frequency
- B. The impulse response, convolved with the input
- C. The response to a constant input
- D. None: every input needs its own measurement
answer: B
family: lti-impulse
task: recall
difficulty: 2
explanation: Any input is a weighted sum of shifted impulses. Linearity adds the weighted responses and time invariance shifts them, which is the convolution of the input with h(t).

### Q2
subskill: 1
type: open
question: Explain why an LTI system's step response is the running integral of its impulse response.
answer: The unit step is the running integral of the unit impulse. Integration is a linear operation that commutes with a time-invariant system, so feeding in the integral of the impulse gives the integral of the impulse response: s(t) = ∫ from 0 to t of h(τ) dτ for a causal system.
rubric: states that the step is the running integral of the impulse; uses linearity and time invariance to move the integral through the system; gives s(t) as the integral of h
family: step-from-impulse
task: explanation
difficulty: 3
explanation: The same argument gives the impulse response as the derivative of the step response.

### Q3
subskill: 2
type: mcq
question: What is the Laplace transform of e^{−3t} for t ≥ 0?
options:
- A. 1/(s − 3)
- B. 3/s
- C. 1/(s + 3)
- D. e^{−3s}
answer: C
family: laplace-exp
task: recall
difficulty: 1
explanation: The integral of e^{−3t} e^{−st} from 0 to ∞ is 1/(s + 3), for Re(s) > −3.

### Q4
subskill: 2
type: short
question: Write the transfer function H(s) = V_out(s)/V_in(s) of an RC low-pass filter, with the output across the capacitor, in terms of s, R and C.
answer: 1/(1 + s*R*C)
family: rc-transfer
task: application
difficulty: 2
explanation: The capacitor's impedance is 1/(sC). The voltage divider gives (1/(sC)) / (R + 1/(sC)) = 1/(1 + sRC).

### Q5
subskill: 3
type: mcq
question: A first-order low-pass filter with time constant τ gets a unit step at t = 0. Where is its output at t = τ?
options:
- A. At its final value, 1
- B. About 0.63
- C. About 0.37
- D. 0.5
answer: B
family: tau-63
task: prediction
difficulty: 1
explanation: 1 − e^{−1} ≈ 0.632. The output is within 5% of its final value only after about 3τ.

### Q6
subskill: 3
type: short
question: An RC low-pass filter has R = 1 kΩ and C = 1 µF. What is its cutoff frequency in rad/s?
answer: 1000
family: rc-cutoff
task: application
difficulty: 2
explanation: τ = RC = 10^3 · 10^{−6} = 10^{−3} s, and ω_c = 1/τ = 1000 rad/s (about 159 Hz).

### Q7
subskill: 3
type: short
part: rc-step 1/4
task: prediction
question: **Predict** · An RC low-pass filter with R = 1 kΩ and C = 1 mF starts uncharged, and a 1 V step is applied at t = 0. Before working anything out, predict three values of the output voltage: just after the step, after a very long time, and at t = 1 s, the last to two decimal places. Give them in that order, separated by commas.
answer: 0 V, 1 V, 0.63 V
family: rc-step-predict
difficulty: 2
explanation: The capacitor's voltage cannot jump, so it starts at 0. It settles at the input, 1 V. τ = RC = 1 s, and 1 − e^{−1} ≈ 0.63.

### Q8
subskill: 3
type: short
part: rc-step 2/4
task: application
question: **Plot** · The plot shows the step response v(t) = 1 − e^(−t) of the same filter, with a point P at t = 0 and its tangent. What is the slope of the tangent at t = 0, in volts per second?
answer: 1
activity: {"moduleId":"function-plotter","assessmentId":"slope-at-point","settings":{"family":"decay","coefficients":[1],"scale":-1,"shiftX":0,"shiftY":1,"domain":[0,6],"viewport":[-0.5,1.3,6,-0.2],"pointX":0},"predictionQuestion":"This is v(t) = 1 − e^(−t), the step response with τ = 1 s, and P sits at t = 0. Predict the slope of the tangent at P, then enter it. Keep P at t = 0: that is the point this part asks about.","hint":"Differentiate 1 − e^(−t/τ) and put t = 0: the initial slope is 1/τ."}
family: rc-step-slope
difficulty: 2
explanation: dv/dt = e^{−t}/τ, which is 1/τ = 1 V/s at t = 0. The tangent at t = 0 meets the final value at t = τ, which is one way to read τ off a scope trace.

### Q9
subskill: 2
type: open
part: rc-step 3/4
task: application
question: **Derive** · Derive the step response v(t) of the same filter (τ = RC = 1 s, a 1 V step at t = 0) with the Laplace transform. Show each step, and end with a line of the form v(t) = ….
answer: The input is V_in(s) = 1/s and the transfer function is H(s) = 1/(1 + s). So V(s) = 1/(s(s + 1)). Partial fractions: 1/(s(s + 1)) = 1/s − 1/(s + 1). The inverse transforms are 1 and e^{−t} for t ≥ 0, so
v(t) = 1 - exp(-t)
rubric: writes the step input as 1/s; uses H(s) = 1/(1 + s) for RC = 1 s; forms V(s) = 1/(s(s + 1)); splits it into 1/s − 1/(s + 1) by partial fractions; inverts each term to reach 1 − e^{−t} for t ≥ 0
family: rc-step-derive
difficulty: 3
explanation: SymPy checks only the final line against 1 − e^{−t}. The partial fractions and the inverse transforms are judged against the rubric, apart from that check.

### Q10
subskill: 3
type: open
part: rc-step 4/4
task: explanation
question: **Explain the discrepancy** · You build the filter with a 1 kΩ resistor and a 1 mF electrolytic capacitor, and the scope shows the output reaching 63% of the step at 1.2 s, not 1 s. Give two physical reasons that could explain the difference, and say how you would test one of them. Then say what the SymPy check on your derivation did, and did not, establish about this circuit.
answer: Possible reasons: the capacitor's real value is higher than marked (electrolytics are often ±20%, so 1.2 mF is within tolerance); the source's output resistance adds to R (about 200 Ω here would do it); the resistor is above its marked value. A resistive load or leakage across the capacitor would shorten the time constant, not lengthen it, and the probe's capacitance is negligible next to 1 mF. To test the first, measure C with a meter or swap in a film capacitor; to test the second, measure the source's output resistance or drive the filter from a low-impedance buffer. The SymPy check showed only that the final expression equals 1 − e^{−t} for the ideal model with RC = 1 s. It did not show that the derivation was sound, and it says nothing about whether the ideal model describes this circuit: that is a physical question the measurement answers.
rubric: gives at least two distinct physical causes that lengthen the time constant (C or R above its marked value, source or wiring resistance in series), and does not offer one that would shorten it (a parallel load, leakage); proposes a concrete test for one cause; says the SymPy check verified the final expression for the ideal model only; says it does not show the derivation was sound or that the model fits the real circuit
family: rc-step-discrepancy
difficulty: 4
explanation: This part is marked on its own, against the rubric, by a separate assessor that sees neither your plot nor your derivation.
