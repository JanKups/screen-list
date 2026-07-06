// A scenario's verdict is a list of individually-named checks. Every grader adds
// {text, passed, evidence} rows (the same field names skill-creator's grading.json
// uses, so results drop straight into that viewer). A scenario passes iff every
// check passes.
export class Checks {
	constructor(scenarioId) {
		this.scenarioId = scenarioId;
		this.items = [];
	}

	add(text, passed, evidence = "") {
		this.items.push({ text, passed: !!passed, evidence: String(evidence) });
		return !!passed;
	}

	get passed() {
		return this.items.length > 0 && this.items.every((i) => i.passed);
	}

	print() {
		for (const i of this.items) {
			const mark = i.passed ? "  ✓" : "  ✗";
			const ev = i.evidence ? `  — ${i.evidence}` : "";
			console.log(`${mark} ${i.text}${i.passed ? "" : ev}`);
		}
	}
}
