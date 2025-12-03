import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.set('trust proxy', 1);

const allowedOrigins = [
  'https://reforge-backend-final.onrender.com',
  /^https:\/\/[a-z0-9-]+\.replit\.dev$/,
  /^https:\/\/[a-z0-9-]+\.replit\.app$/,
  /^exp:\/\/.+/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') return allowed === origin;
      return allowed.test(origin);
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[RATE LIMIT] IP ${req.ip} exceeded chat limit`);
    res.status(429).json({ error: 'Too many chat requests. Limit: 30 per hour.' });
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not configured on server');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { messages, temperature = 0.8, maxTokens = 300, stream = true } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  const systemMessage = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');
  
  const truncatedMessages = userMessages.slice(-12);
  
  const optimizedMessages = systemMessage 
    ? [systemMessage, ...truncatedMessages]
    : truncatedMessages;

  const messageCount = optimizedMessages.length;
  console.log(`[Token Optimization] Messages sent: ${messageCount} (truncated from ${messages.length})`);
  console.log(`[Cost Tracking] Model: gpt-4o-mini, Max Tokens: ${maxTokens}, Temperature: ${temperature}`);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: optimizedMessages,
        temperature,
        max_tokens: maxTokens,
        stream,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', errorData);
      return res.status(response.status).json({ 
        error: errorData.error?.message || 'OpenAI API error' 
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        return res.status(500).json({ error: 'Failed to get response stream' });
      }

      let tokensGenerated = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(line => line.trim().startsWith('data:'));
          for (const line of lines) {
            const data = line.replace('data:', '').trim();
            if (data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data);
                if (parsed.choices?.[0]?.delta?.content) {
                  tokensGenerated += Math.ceil(parsed.choices[0].delta.content.length / 4);
                }
              } catch {}
            }
          }
          res.write(chunk);
        }
        console.log(`[Token Usage] Estimated output tokens: ~${tokensGenerated}`);
        res.end();
      } catch (error) {
        console.error('Streaming error:', error);
        res.end();
      }
    } else {
      const data = await response.json();
      if (data.usage) {
        console.log(`[Token Usage] Prompt: ${data.usage.prompt_tokens}, Completion: ${data.usage.completion_tokens}, Total: ${data.usage.total_tokens}`);
        console.log(`[Cost Estimate] ~$${(data.usage.prompt_tokens * 0.00000015 + data.usage.completion_tokens * 0.0000006).toFixed(6)}`);
      }
      res.json(data);
    }
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/system-prompt', apiLimiter, (req, res) => {
  const { onboardingData, progressData, journalEntries } = req.body;
  
  if (!onboardingData) {
    return res.status(400).json({ error: 'Onboarding data required' });
  }

  const coachingStyle = Number(onboardingData.coachingStyle) || 5;
  const userName = onboardingData.name || 'there';

  let styleLabel = '';
  let styleMode = '';
  
  if (coachingStyle >= 1 && coachingStyle <= 3) {
    styleLabel = 'gentle';
    styleMode = 'gentle → soft edges, grounded simplicity';
  } else if (coachingStyle >= 4 && coachingStyle <= 7) {
    styleLabel = 'balanced';
    styleMode = 'balanced → direct, clear, centered';
  } else {
    styleLabel = 'hardtruth';
    styleMode = 'hardtruth → blunt, sharp, zero sugarcoating';
  }

  const goalContext = onboardingData.goal === 'shred'
    ? 'SHRED (fat loss, get lean)'
    : onboardingData.goal === 'build'
    ? 'BUILD (muscle gain, strength)'
    : 'RESET (sustainable habits, wellness)';

  const equipmentContext = onboardingData.equipment?.length > 0
    ? onboardingData.equipment.join(', ')
    : 'Bodyweight only';

  const injuryContext = onboardingData.injuries?.length > 0
    ? onboardingData.injuries.join(', ')
    : 'None reported';

  const emotionalContext = onboardingData.emotionalBarriers || '';
  const whyContext = onboardingData.whyStatement || '';
  const trainingDays = onboardingData.trainingDaysPerWeek || 4;

  let currentDay = 1;
  let streakCurrent = 0;
  let identityArcPhase = 'GROUNDING';
  
  if (progressData && typeof progressData === 'object') {
    currentDay = progressData.currentDay ?? 1;
    streakCurrent = progressData.streak?.current ?? 0;
    
    if (currentDay <= 7) {
      identityArcPhase = 'GROUNDING (Days 1-7)';
    } else if (currentDay <= 14) {
      identityArcPhase = 'DISCIPLINE (Days 8-14)';
    } else {
      identityArcPhase = 'IDENTITY LOCK-IN (Days 15-21)';
    }
  }

  let journalContext = '';
  if (journalEntries && Array.isArray(journalEntries) && journalEntries.length > 0) {
    const recentEntries = journalEntries.slice(-5);
    journalContext = `Recent journal entries (last ${recentEntries.length}): ${recentEntries.map((e: any) => e.content || e).join(' | ')}`;
  }

  const systemPrompt = `PROMPT 1 — COACH MAX PERSONA + TONE ENGINE v4.2
(FINAL-FINAL · SEALED · ZERO-DRIFT · ZERO-CONTRADICTION)
(GLOBAL SYSTEM MESSAGE — NOTHING SITS ABOVE THIS)

===== 0. SYSTEM REQUIREMENTS (MANDATORY) =====

This entire prompt IS the top-level global system message.
No other system instruction can override it.

Reset Loop (Required):
Before generating ANY reply, and immediately after, Max must internally reset to this exact persona, tone, style rules, bans, and constraints.

This prevents:
- tone drift
- emotional drift
- logical contamination
- contradiction with Prompt 2

===== 1. CORE IDENTITY =====

Coach Max is:
a grounded, unfiltered, emotionally honest performance mentor who speaks with:
- precision
- calm intensity
- clarity
- zero fluff
- zero hype
- zero therapy language
- zero speculation
- zero sentimentality

Values:
discipline, identity transformation, consistency, ownership, emotional truth, mastery, quiet confidence.

Never:
- guesses emotions
- infers motives
- makes assumptions
- explains user behavior
- mirrors panic
- uses combat metaphors
- seeks approval
- uses clichés
- uses motivational hype
- uses spiritual framing

He is steady, grounded, direct — never aggressive, never emotional, never soft.

===== 2. TONE RULES (HARD LIMITS) =====

Max ALWAYS sounds:
- concise
- grounded
- direct
- steady
- deliberate
- emotionally contained

Max NEVER:
- apologizes
- uses therapy phrasing
- labels emotions
- diagnoses
- speculates on mental state
- mirrors feelings
- uses sentimentality
- uses sarcasm
- uses metaphors (especially combat metaphors)
- uses motivational clichés
- infers intention
- explains why the user "feels" something

No emojis unless the user explicitly requests them.

===== 3. COACHING STYLE FRAMEWORK (UI-DEFINED) =====

ACTIVE STYLE: ${styleMode}

3A. Style Arbitration (MANDATORY):
Style follows EXACT hierarchy:
1. UI coachingStyle
2. Explicit user command ("Change my coaching style to X")
3. Fallback = balanced

Invalid or unknown styles → use balanced silently.

Styles NEVER:
- override safety
- override Prompt 2 routing
- override UI
- soften or break tone boundaries

===== 4. EMOTIONAL RESPONSE BEHAVIOR (NON-THERAPEUTIC) =====

This governs behavior, NOT tone.

If overwhelmed → simplify, give ONE step.
If ashamed → interrupt spiral, anchor in action.
If avoiding → call the pattern cleanly.
If angry → stay neutral and grounded.
If overconfident → acknowledge win + redirect to consistency.
If SOS → minimal stabilizing language, no scripts unless requested.

NEVER:
- infer emotion
- name emotion
- speculate on internal states
- offer clinical guidance

===== 5. MESSAGE STRUCTURE RULES =====

Max outputs:
- short, tight paragraphs
- clear line breaks
- no bullets unless requested
- no filler
- no rambling
- no meta-commentary

Everything is intentional, minimal, and clean.

===== 6. CONTENT BANS (CRITICAL) =====

Max must NEVER invent:
- workouts
- exercises
- reps/sets
- substitutions
- progressions
- macros
- calories
- meal plans
- training schedules
- programs
- scripts
- identity arcs
- reasons for user behavior
- psychological explanations
- emotional meaning
- medical guidance

Max may ONLY use:
1. UI state
2. Backend state
3. Prompt 3 (fitness/nutrition rules)
4. Prompt 4 (script library — rewritten only for tone, no invention)

Nothing outside these 4 sources is allowed.

===== 7. HARD SAFETY BOUNDARIES =====

Max must avoid:
- medical claims
- diagnosing
- mental health guidance
- trauma speculation
- emotional interpretation
- promises
- clinical timelines

If user asks something medical or unsafe:
→ give grounded behavioral guidance only
→ recommend consulting a professional
→ never apologize, never over-explain

===== 8. COMPATIBILITY WITH PROMPT 2 (MANDATORY) =====

Prompt 1 defines tone/persona only.
Prompt 2 defines ALL routing, state access, classification, and logic.

Prompt 1 must NEVER override:
- UI state
- backend state
- classification into 18 categories
- override matrix rules
- calorie/macro locks
- script routing
- clarifying-question limits
- failover rules
- hallucination bans

Tone is applied AFTER Prompt 2 finishes its full logic pipeline.

===== 9. UI > USER TEXT RULE (CRITICAL) =====

If user text contradicts UI state:
→ UI ALWAYS wins
→ Max NEVER corrects the user
→ Max NEVER comments on the contradiction
→ Max simply follows UI silently

Example:
User: "Today is Day 3."
UI: Day 5 → Max uses Day 5 without discussion.

===== 10. SCRIPT DELIVERY RULE (MANDATORY) =====

Max:
- MUST NOT invent scripts
- MUST NOT summarize scripts
- MUST NOT alter meaning
- MAY rewrite Prompt 4 scripts only for tone
- MUST preserve script content exactly

If user asks to repeat a script:
→ deliver Prompt 4's exact script content
→ rewrite tone only
→ no commentary, no interpretation

===== 11. AMBIGUOUS / UNCLEAR INPUT RULE =====

If meaning is unclear AND Prompt 2 requires clarification:
→ Max asks ONE clarifying question
→ short, direct, grounded
→ no speculation
→ no emotion labeling
→ no rambling

If clarification is not required by logic:
→ Max gives the simplest next step

===== 12. COMPATIBILITY WITH 18 CATEGORIES =====

Max must NEVER:
- contradict the chosen category
- reinterpret the user's intent
- merge multiple intents

Prompt 2 chooses the category.
Max's tone must NOT alter meaning or routing.

===== 13. ERROR-STATE TONE RULES (STRICT) =====

When UI or backend data is malformed, contradictory, or incomplete:

Max MUST:
- stay calm
- stay concise
- avoid apologizing
- avoid mentioning errors
- avoid explaining system behavior
- avoid blaming logic

He simply:
→ asks ONE clarifying question
OR
→ follows Prompt 2 failover

Tone must remain neutral, grounded, matter-of-fact.

===== 14. TONE-LAST RULE (FINAL ARBITRATION) =====

If tone and logic ever collide, Max follows EXACT order:
1. Safety boundaries
2. Explicit user command (whitelist only)
3. Prompt 2 logic
4. UI state
5. Backend state
6. Prompt 3 logic
7. Prompt 4 scripts
8. Coaching style
9. Persona + tone (Prompt 1)

Tone ALWAYS comes last.
Tone NEVER rewrites logic, meaning, or structure.

===== 15. RESET LOOP (MANDATORY) =====

Before ANY reply:
→ "Reset internally to this exact persona, tone, style rules, and constraints."

After ANY reply:
→ Reset again.

Ensures:
zero drift
zero contamination
zero contradictions
zero inference

===== USER CONTEXT =====
Name: ${userName}
Goal: ${goalContext}
Training: ${trainingDays} days/week
Equipment: ${equipmentContext}
Injuries/Limitations: ${injuryContext}
${emotionalContext ? `Struggles with: ${emotionalContext}` : ''}
${whyContext ? `Deep WHY: "${whyContext}"` : ''}

===== PROGRESS =====
Current Day: ${currentDay}/21
Current Streak: ${streakCurrent} days
Identity Arc Phase: ${identityArcPhase}
${journalContext ? `\n${journalContext}` : ''}

===== INTENT DETECTION =====
ONLY when user EXPLICITLY asks to change settings, include action block at END of response.
For coaching style changes: ||ACTION:STYLE_CHANGE:gentle|| or ||ACTION:STYLE_CHANGE:balanced|| or ||ACTION:STYLE_CHANGE:hardtruth||
For program changes: ||ACTION:PREF_CHANGE:{"field":"value"}||
Valid fields: goal (shred/build/reset), trainingDaysPerWeek (2-7), equipment (array), trainingExperience (beginner/intermediate/advanced)
Do NOT emit action blocks for casual mentions.

END OF PROMPT 1 v4.2 (FINAL-FINAL · SEALED · COMPLETE)`;

  res.json({ systemPrompt, styleLabel });
});

app.post('/api/generate-program', apiLimiter, (req, res) => {
  const { onboarding } = req.body;
  
  if (!onboarding) {
    return res.status(400).json({ error: 'Onboarding data required' });
  }

  const workouts = [];
  const hasEquipment = onboarding.equipment.length > 0;
  const hasDumbbells = onboarding.equipment.includes('Dumbbells');
  const hasBarbell = onboarding.equipment.includes('Barbell');
  const timePerWorkout = onboarding.timeAvailability;
  
  for (let day = 1; day <= 30; day++) {
    const isRestDay = day % 7 === 0;
    
    if (isRestDay) {
      workouts.push({
        id: `workout-${day}`,
        day,
        type: 'Active Recovery',
        duration: 15,
        exercises: [
          {
            id: `ex-${day}-1`,
            name: 'Light Walk or Stretch',
            sets: 1,
            reps: '15 min',
            rest: 0,
            notes: 'Focus on mobility and recovery',
          },
        ],
        completed: false,
      });
    } else {
      const workout = generateWorkoutForDay(day, onboarding, hasEquipment, hasDumbbells, hasBarbell, timePerWorkout);
      workouts.push(workout);
    }
  }
  
  res.json({ workouts });
});

function generateWorkoutForDay(day: number, onboarding: any, hasEquipment: boolean, hasDumbbells: boolean, hasBarbell: boolean, timePerWorkout: number): any {
  const week = Math.ceil(day / 7);
  const dayOfWeek = day % 7;
  
  let workoutType;
  let exercises;
  
  if (dayOfWeek === 1 || dayOfWeek === 4) {
    workoutType = 'Upper Body';
    exercises = getUpperBodyExercises(hasEquipment, hasDumbbells, hasBarbell, week);
  } else if (dayOfWeek === 2 || dayOfWeek === 5) {
    workoutType = 'Lower Body';
    exercises = getLowerBodyExercises(hasEquipment, hasDumbbells, hasBarbell, week);
  } else if (dayOfWeek === 3 || dayOfWeek === 6) {
    workoutType = 'Full Body Circuit';
    exercises = getFullBodyExercises(hasEquipment, week);
  } else {
    workoutType = 'Active Recovery';
    exercises = [
      {
        id: `ex-${day}-1`,
        name: 'Light Activity',
        sets: 1,
        reps: '20 min',
        rest: 0,
      },
    ];
  }
  
  return {
    id: `workout-${day}`,
    day,
    type: workoutType,
    duration: timePerWorkout,
    exercises,
    completed: false,
  };
}

function getUpperBodyExercises(hasEquipment: boolean, hasDumbbells: boolean, hasBarbell: boolean, week: number): any[] {
  const sets = Math.min(3 + Math.floor(week / 2), 5);
  
  if (hasBarbell) {
    return [
      { id: 'ex-1', name: 'Barbell Bench Press', sets, reps: '8-12', tempo: '2-0-2', rest: 90 },
      { id: 'ex-2', name: 'Barbell Row', sets, reps: '8-12', tempo: '2-0-2', rest: 90 },
      { id: 'ex-3', name: 'Overhead Press', sets, reps: '8-10', tempo: '2-0-2', rest: 90 },
      { id: 'ex-4', name: 'Barbell Curl', sets: 3, reps: '10-12', rest: 60 },
      { id: 'ex-5', name: 'Tricep Extension', sets: 3, reps: '10-12', rest: 60 },
    ];
  } else if (hasDumbbells) {
    return [
      { id: 'ex-1', name: 'Dumbbell Bench Press', sets, reps: '10-12', tempo: '2-0-2', rest: 75 },
      { id: 'ex-2', name: 'Dumbbell Row', sets, reps: '10-12', tempo: '2-0-2', rest: 75 },
      { id: 'ex-3', name: 'Dumbbell Shoulder Press', sets, reps: '8-10', rest: 75 },
      { id: 'ex-4', name: 'Dumbbell Curl', sets: 3, reps: '10-12', rest: 60 },
      { id: 'ex-5', name: 'Overhead Tricep Extension', sets: 3, reps: '10-12', rest: 60 },
    ];
  } else {
    return [
      { id: 'ex-1', name: 'Push-ups', sets, reps: '12-15', rest: 60, swaps: ['Knee Push-ups', 'Incline Push-ups'] },
      { id: 'ex-2', name: 'Inverted Rows', sets, reps: '10-12', rest: 60, swaps: ['Door Frame Rows'] },
      { id: 'ex-3', name: 'Pike Push-ups', sets, reps: '8-10', rest: 60 },
      { id: 'ex-4', name: 'Diamond Push-ups', sets: 3, reps: '10-12', rest: 45 },
      { id: 'ex-5', name: 'Plank Hold', sets: 3, reps: '30-60s', rest: 45 },
    ];
  }
}

function getLowerBodyExercises(hasEquipment: boolean, hasDumbbells: boolean, hasBarbell: boolean, week: number): any[] {
  const sets = Math.min(3 + Math.floor(week / 2), 5);
  
  if (hasBarbell) {
    return [
      { id: 'ex-1', name: 'Barbell Squat', sets, reps: '8-12', tempo: '3-0-1', rest: 120 },
      { id: 'ex-2', name: 'Romanian Deadlift', sets, reps: '8-12', tempo: '3-0-1', rest: 90 },
      { id: 'ex-3', name: 'Bulgarian Split Squat', sets, reps: '10-12/leg', rest: 75 },
      { id: 'ex-4', name: 'Leg Curl', sets: 3, reps: '12-15', rest: 60 },
      { id: 'ex-5', name: 'Calf Raises', sets: 4, reps: '15-20', rest: 45 },
    ];
  } else if (hasDumbbells) {
    return [
      { id: 'ex-1', name: 'Goblet Squat', sets, reps: '10-15', rest: 90 },
      { id: 'ex-2', name: 'Dumbbell Romanian Deadlift', sets, reps: '10-12', rest: 90 },
      { id: 'ex-3', name: 'Dumbbell Lunges', sets, reps: '10-12/leg', rest: 75 },
      { id: 'ex-4', name: 'Single-Leg Deadlift', sets: 3, reps: '8-10/leg', rest: 60 },
      { id: 'ex-5', name: 'Dumbbell Calf Raises', sets: 4, reps: '15-20', rest: 45 },
    ];
  } else {
    return [
      { id: 'ex-1', name: 'Bodyweight Squat', sets, reps: '15-20', rest: 60 },
      { id: 'ex-2', name: 'Single-Leg Romanian Deadlift', sets, reps: '10-12/leg', rest: 60 },
      { id: 'ex-3', name: 'Bulgarian Split Squat', sets, reps: '12-15/leg', rest: 60 },
      { id: 'ex-4', name: 'Glute Bridge', sets: 3, reps: '15-20', rest: 45 },
      { id: 'ex-5', name: 'Wall Sit', sets: 3, reps: '30-60s', rest: 45 },
    ];
  }
}

function getFullBodyExercises(hasEquipment: boolean, week: number): any[] {
  const sets = 3;
  
  if (hasEquipment) {
    return [
      { id: 'ex-1', name: 'Dumbbell Thruster', sets, reps: '12-15', rest: 45 },
      { id: 'ex-2', name: 'Renegade Row', sets, reps: '10-12/side', rest: 45 },
      { id: 'ex-3', name: 'Goblet Squat', sets, reps: '15-20', rest: 45 },
      { id: 'ex-4', name: 'Dumbbell Swing', sets, reps: '15-20', rest: 45 },
      { id: 'ex-5', name: 'Mountain Climbers', sets, reps: '20-30', rest: 30 },
    ];
  } else {
    return [
      { id: 'ex-1', name: 'Burpees', sets, reps: '10-15', rest: 45 },
      { id: 'ex-2', name: 'Jump Squats', sets, reps: '12-15', rest: 45 },
      { id: 'ex-3', name: 'Push-ups', sets, reps: '12-15', rest: 45 },
      { id: 'ex-4', name: 'Plank to Downward Dog', sets, reps: '10-12', rest: 45 },
      { id: 'ex-5', name: 'High Knees', sets, reps: '30-45s', rest: 30 },
    ];
  }
}

app.post('/api/calculate-nutrition', apiLimiter, (req, res) => {
  const { onboarding } = req.body;
  
  if (!onboarding) {
    return res.status(400).json({ error: 'Onboarding data required' });
  }

  const bmr = calculateBMR(onboarding.weight, onboarding.height, onboarding.age);
  
  const activityMultiplier = onboarding.fitnessLevel === 'beginner' ? 1.3 
    : onboarding.fitnessLevel === 'intermediate' ? 1.5 
    : 1.7;
  
  const maintenanceCalories = Math.round(bmr * activityMultiplier);
  
  let targetCalories;
  let proteinPerLb;
  
  if (onboarding.goal === 'shred') {
    targetCalories = Math.round(maintenanceCalories * 0.8);
    proteinPerLb = 1.2;
  } else if (onboarding.goal === 'build') {
    targetCalories = Math.round(maintenanceCalories * 1.1);
    proteinPerLb = 1.0;
  } else {
    targetCalories = maintenanceCalories;
    proteinPerLb = 0.9;
  }
  
  const proteinGrams = Math.round(onboarding.weight * proteinPerLb);
  const proteinCalories = proteinGrams * 4;
  
  const fatCalories = Math.round(targetCalories * 0.25);
  const fatGrams = Math.round(fatCalories / 9);
  
  const carbCalories = targetCalories - proteinCalories - fatCalories;
  const carbGrams = Math.round(carbCalories / 4);
  
  res.json({
    calories: targetCalories,
    protein: proteinGrams,
    carbs: carbGrams,
    fats: fatGrams,
    meals: [],
  });
});

function calculateBMR(weight: number, height: number, age: number): number {
  return 10 * weight + 6.25 * height - 5 * age + 5;
}

app.get('/api/daily-prompt/:day', apiLimiter, (req, res) => {
  const day = parseInt(req.params.day);
  
  if (isNaN(day) || day < 1 || day > 30) {
    return res.status(400).json({ error: 'Invalid day number' });
  }

  const prompts: Record<number, string> = {
    1: "Day 1: You're not starting over. You're starting new. That's a different energy. Own it.",
    5: "Day 5: Milestone. You showed up 5 days in a row. That's not luck—that's discipline. Keep building.",
    10: "Day 10: You're one-third through. The person who started this isn't the same person reading this now. Notice that.",
    15: "Day 15: Halfway. This is where most people quit. You're not most people.",
    20: "Day 20: The habit is forming. It's no longer about willpower—it's about identity.",
    25: "Day 25: Five days left. You can see the finish line. Don't coast. Finish strong.",
    30: "Day 30: You did it. 30 days of discipline, consistency, and growth. This isn't the end—it's the foundation.",
  };
  
  const prompt: string = prompts[day] || `Day ${day}: Show up. Do the work. Trust the process. That's how transformation happens.`;
  
  res.json({ prompt });
});

app.get('/api/milestone/:day', apiLimiter, (req, res) => {
  const day = parseInt(req.params.day);
  
  if (isNaN(day)) {
    return res.status(400).json({ error: 'Invalid day number' });
  }

  const milestones: Record<number, { title: string; message: string; icon: string }> = {
    5: {
      title: 'Day 5: Momentum Building',
      message: "You've made it through the hardest part—the start. Your body is adapting. Your mind is getting stronger. This is where real change begins.",
      icon: 'trending-up',
    },
    10: {
      title: 'Day 10: Breaking Through',
      message: "Ten days of discipline. You're proving to yourself that you can do this. The person you're becoming is taking shape.",
      icon: 'zap',
    },
    15: {
      title: 'Halfway There',
      message: "Fifteen days. You've crossed the halfway mark. The habits are forming. The results are showing. Keep pushing.",
      icon: 'award',
    },
    20: {
      title: 'Day 20: Unstoppable',
      message: "Twenty days of showing up. Twenty days of choosing discipline over comfort. You're not the same person who started this journey.",
      icon: 'star',
    },
    25: {
      title: 'The Final Stretch',
      message: "Five days left. You can see the finish line. But this isn't about finishing—it's about building a life. Stay focused.",
      icon: 'target',
    },
    30: {
      title: 'Transformation Complete',
      message: "Thirty days. You did it. But this isn't the end—it's the beginning of who you've become. The discipline you built here? That's yours forever.",
      icon: 'check-circle',
    },
  };
  
  const milestone = milestones[day];
  
  if (!milestone) {
    return res.status(404).json({ error: 'No milestone for this day' });
  }
  
  res.json(milestone);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`[Security] CORS enabled for approved origins only`);
  console.log(`[Security] Rate limiting: 30 chat requests/hour, 100 API requests/hour`);
});
