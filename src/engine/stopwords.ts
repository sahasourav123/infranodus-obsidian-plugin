// English stopwords used by the local text network engine.
// Function words, auxiliaries, pronouns, generic adverbs and common
// markdown / note-taking noise that would otherwise dominate the graph.
const BASE = `
a about above across actually after afterwards again against all almost alone along already also although always am among amongst amount an and another any anyhow anyone anything anyway anyways anywhere are aren around as aside at away
b back be became because become becomes becoming been before beforehand behind being below beside besides best better between beyond both bottom but by
c call can cannot cant could couldn
d did didn do does doesn doing don done down due during
e each eg eight either eleven else elsewhere empty enough especially etc even ever every everyone everything everywhere except
f few fifteen fifty fill find first five for former formerly forty four from front full further furthermore
g get gets getting give given gives go goes going gone got gotten
h had hadn has hasn have haven having he hence her here hereafter hereby herein hereupon hers herself him himself his how however hundred
i ie if in inc indeed instead into is isn it its itself
j just
k keep keeps kept know known knows
l last later latter latterly least less let lets like likely ll
m made make makes making many may maybe me meanwhile might mine more moreover most mostly move much must my myself
n name namely need needs neither never nevertheless new next nine no nobody none noone nor not nothing now nowhere
o of off often ok okay on once one only onto or other others otherwise our ours ourselves out over overall own
p part per perhaps please put
q quite
r rather re really regarding
s said same say says see seem seemed seeming seems seen self several shall she should shouldn show side since six sixty so some somehow someone something sometime sometimes somewhere still such
t take taken takes than that the their theirs them themselves then thence there thereafter thereby therefore therein thereupon these they thing things third this those though three through throughout thru thus to together too top toward towards twelve twenty two
u under unless until up upon us use used uses using usually
v ve very via
w want wants was wasn way ways we well were weren what whatever when whence whenever where whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will with within without won would wouldn
x y yes yet you your yours yourself yourselves
z
im ive id youre youve youd hes shes theyre theyve weve wed itll thats theres whats lets cannot
via vs etc eg ie aka
today tomorrow yesterday
jan feb mar apr jun jul aug sep sept oct nov dec
mon tue tues wed thu thur thurs fri sat sun
monday tuesday wednesday thursday friday saturday sunday
am pm etc via plus
also just even still yet ever much many more most less least lot lots
first second third
`;

// Note-taking, markdown and Obsidian noise
const NOTES = `
todo done tbd md http https www com org html png jpg jpeg gif pdf svg
created updated completion effort status tags tag aliases alias type kind review
note notes page pages file files link links
`;

const STOPWORDS: Set<string> = new Set(
	(BASE + " " + NOTES)
		.split(/\s+/)
		.map((w) => w.trim().toLowerCase())
		.filter(Boolean)
);

export { STOPWORDS };
