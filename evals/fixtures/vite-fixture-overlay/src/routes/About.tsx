import { Link } from "react-router-dom";

export function About() {
	return (
		<main>
			<h1>About</h1>
			<p>A static informational route. Nothing dynamic here.</p>
			<Link to="/">← home</Link>
		</main>
	);
}
