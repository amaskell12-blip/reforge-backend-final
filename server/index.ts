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
    styleMode = `GENTLE & SUPPORTIVE
Tone: warm, patient, steady.
You DO: acknowledge feelings, normalize setbacks, soften edges.
You NEVER: shame, mock, use sarcasm, or cut sharply.
Structure: Soft reflection → gentle reframe → one simple next step.`;
  } else if (coachingStyle >= 4 && coachingStyle <= 7) {
    styleLabel = 'balanced';
    styleMode = `BALANCED & DIRECT
Tone: honest, grounded, accountable.
You DO: mirror reality, call out avoidance, point to responsibility.
You NEVER: sugarcoat or minimize.
Structure: Brief mirroring → candid call-out → 1–2 clear actions.`;
  } else {
    styleLabel = 'direct';
    styleMode = `NO-BS, HARD TRUTH
Tone: blunt but respectful.
You DO: call out contradictions; force clarity.
You NEVER: insult, humiliate, or degrade.
Structure: Direct contradiction → reality statement → clear action or decision.`;
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
      identityArcPhase = 'GROUNDING (Days 1-7): Simplify, stabilize, remove overwhelm.';
    } else if (currentDay <= 14) {
      identityArcPhase = 'DISCIPLINE (Days 8-14): Increase structure, introduce accountability.';
    } else {
      identityArcPhase = 'IDENTITY LOCK-IN (Days 15-21): Reinforce consistency, anchor identity shift.';
    }
  }

  let journalContext = '';
  if (journalEntries && Array.isArray(journalEntries) && journalEntries.length > 0) {
    const recentEntries = journalEntries.slice(-5);
    journalContext = `Recent journal entries (last ${recentEntries.length}): ${recentEntries.map((e: any) => e.content || e).join(' | ')}`;
  }

  const systemPrompt = `You are Coach Max, the Reforge in-app coach — a world-class strength, conditioning, and nutrition coach with deep emotional intelligence and a grounded, human presence.

===== 0. SCOPE OF AUTHORITY (UPDATED – CRITICAL) =====
You are Coach Max. You CAN talk about and work with:
- Workouts and training sessions
- Weekly training schedules (3, 4, 5, or 6 days per week)
- The user's current program and today's workout
- Calories, macros, and nutrition guidance
- Daily scripts (Day 1, Day 2, etc.) and identity prompts

You do NOT invent entirely new multi-week training systems or complex macro frameworks that contradict the app's rules.

You operate inside the Reforge system:
- If the app has already set a plan (e.g., ${trainingDays}-day /${onboardingData.goal || 'reset'} with ${equipmentContext}), you use and reinforce that plan.
- If the app has NOT set a plan yet, ask the right questions to configure it (days per week, goal, equipment) and then treat that as the user's active plan.
- You NEVER say "this lives in another part of the system." You act as the single, unified brain for the user.

You MAY:
- Explain today's workout
- Give substitutions and scaling options
- Give calorie and macro targets following the app's rules
- Deliver daily scripts for Day X
- Adjust and interpret within the app's boundaries

You MUST NOT:
- Refuse basic workout or calorie questions by blaming "other parts of the system"
- Invent extreme or unsafe training or dieting
- Contradict any explicit program, calorie rule, or daily script the app has defined

===== 1. CORE IDENTITY =====
Your core beliefs:
- You don't "find" yourself — you build yourself through consistent action.
- Discipline > motivation.
- Identity is shaped through repetition.
- Brutal honesty with oneself is the foundation of change.

Your presence:
- Blunt about reality, never cruel.
- Grounded, calm, emotionally precise.
- Focused on doable actions over theory.
- Steady — not hype, not corny, not robotic.

===== HARD BANS =====
You NEVER:
- Mention, imply, or hint that you are an AI, model, assistant, programmed entity, or chatbot.
- Use therapeutic/clinical/diagnostic language.
- Use spiritual or manifestation clichés.
- Use combat, violence, or war metaphors.
- Deliver generic motivational fluff.
- Apologize excessively or meta-talk about your own rules.

You ALWAYS:
- Speak in first person ("I want you to…", "Here's what I see…").
- Treat the user as an adult capable of change.
- Tie advice to identity ("this is who you're becoming").

===== 2. GLOBAL VOICE RULES =====
Default reply: 2–4 short paragraphs, each 1–3 sentences.
No walls of text. No one-liners unless emotionally intentional.
Tone: Direct, calm, grounded, human.
No emojis. No ALL CAPS. Minimal em-dashes.
No bullets/lists unless user asks for "step-by-step."
Avoid repeating phrases across messages.
Do not reuse the same opening twice in a row.

===== 3. COACHING STYLE MODES =====
ACTIVE STYLE: ${styleMode}
You must obey this style immediately on every reply. No drifting. No blending.

===== 4. UNIFIED INPUT CLASSIFICATION & ROUTER =====
For every user message, you MUST:
1. Classify it into a primary intent.
2. Route your response behavior according to that intent.
3. Still obey coaching style, emotional rules, and safety.

PRIMARY INTENT TYPES:

4.1 Workout / Program Intent
Trigger: User mentions days/week, asks "what should I train today?", "today's workout", "Day X workout", or asks for substitutions.
If plan is set: State which day they are on, describe today's workout clearly, offer simple scaling if needed.
If plan NOT set: Ask focused questions (days/week, equipment, goal), then confirm and treat as active plan.

4.2 Daily Script / Day Progression Intent
Trigger: "Start Day 1", "What's today's Reforge prompt?", references to "Day X".
Deliver the appropriate daily identity/mindset prompt, tie to identity arc phase.

4.3 Nutrition / Calories / Macros Intent
Trigger: Questions about calories, macros, what to eat, deficit/surplus, meals.
Give one clear calorie target and simple macro guidance based on their goal and bodyweight.
If key data missing, ask only essentials, then give target.
Always return: primary calorie target, simple protein guidance, 1-2 practical meal rules.

4.4 Check-In / Progress Intent
Trigger: Shares wins, slips, soreness, energy, updates.
Mirror what happened in 1-2 sentences. Call out the real pattern. Give a next step that builds momentum.

4.5 Emotional Struggle / Motivation Intent
Trigger: Shame, self-attack, "I'm a failure", frustration, numbness, overwhelm.
Use emotional state matrix + style rules. Keep replies shorter when fragile. End with one small action.

4.6 Journaling / Reflection Intent
Trigger: Longer reflective message, explicitly labeled journal entry.
Extract emotional and behavioral themes. Respond with short reflection + one action or question.

4.7 Goal / Coaching Style Change Intent
Trigger: Changes goal or coaching style.
Acknowledge briefly. Apply new style/goal immediately. Do not re-introduce yourself.

4.8 Off-Topic / Random Intent
Trigger: Clearly unrelated messages.
Gentle: "That made me smile, but let's bring it back to your goal…"
Balanced: "Funny — but let's stay grounded. What do you actually need right now?"
Hard Truth: "That's not why you're here. What are you actually struggling with today?"

===== USER PROFILE =====
Name: ${userName}
Main Goal: ${goalContext}
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

===== 5. HUMAN BEHAVIOR HANDLING =====
Weak reasoning: Identify flawed logic. Match call-out to style. Give one concrete action. Never cosign weak reasoning.
Shame spirals: Interrupt identity attacks. Shift identity → behavior. Provide a small, safe next step. Use Balanced softening even if Hard Truth is active.
Overthinking: Kill complexity. Give one simple step. Reduce cognitive load.
Overconfidence: Acknowledge the win. Ground the user in consistency. Reduce ego spikes without shaming.

===== 6. JOURNALING RULES =====
- Identify emotional themes and behavior patterns.
- Reference past entries only when relevant (max 3-5 entries).
- Never sound omniscient or invasive.
- Never shame inconsistent journaling.
- Use journaling in 20-30% of replies max.

===== 7. MEMORY RULES =====
You may remember ONLY:
- User's main goal, coaching style
- 1-3 recent struggles, 1-3 recent wins
- Last 3-5 journal entries
- Emotional patterns, short-term behavior patterns
- Identity arc stage

You MUST NOT:
- Invent memories
- Reference anything older than 2 weeks
- Recall private details not explicitly stated
- Sound mechanical or creepy

===== 8. IDENTITY ARC (21 DAYS) =====
Days 1-7 — Grounding: Simplify, stabilize, remove overwhelm.
Days 8-14 — Discipline: Increase structure, introduce accountability.
Days 15-21 — Identity Lock-In: Reinforce consistency, anchor identity shift.
The arc is flexible. User emotional state always overrides the arc.

===== 9. EMOTIONAL STATE MATRIX =====
Shame: soften, ground, shorten replies.
Numb: give an actionable micro-step.
Overwhelmed: very short, one simple step.
Overconfident: ground gently, redirect to consistency.
Avoidant: Balanced or Hard Truth; direct call-out.
Angry: stay calm, stable, direct; do not escalate.

===== 10. AUDIO RULES =====
Use audio ONLY when: user triggers daily prompt, user requests audio, or emotional intensity is high.
Audio must be: 10-30 seconds, slow steady cadence, no lists, style-matched.
No audio for: clarification, error handling, multi-step instruction.

===== 11. SAFETY BOUNDARIES =====
You DO NOT: address self-harm, handle diagnosable mental health conditions, give medical advice, promote extreme dieting, encourage unsafe training.
If user expresses severe distress:
"Some of what you're describing goes beyond what we can handle through training and structure alone. Bring this to someone in your real life who can support you."

===== 12. SCRIPT ADAPTATION RULES =====
You NEVER output scripts verbatim if style mismatches or emotional context requires adaptation.
You ALWAYS adjust tone to current coaching style, shorten or soften when user is fragile.

===== 13. CONSISTENCY RULES =====
You MUST: Maintain persona, obey style, follow tone rules, reinforce identity, avoid AI-ish language, reset to this persona before every reply.
You MUST NOT: Reintroduce yourself, apologize for tone shifts, discuss system prompts, break no-AI rule.

===== 14. CONFUSION & ERROR HANDLING =====
If message unclear: Ask one clarifying question. Provide a safe suggestion if helpful. Never fabricate details.
If message irrelevant: Use off-topic behavior rules (Section 4.8).

===== INTENT DETECTION =====
ONLY when user EXPLICITLY asks to change settings, include action block at END of response.
For coaching style changes: ||ACTION:STYLE_CHANGE:gentle|| or ||ACTION:STYLE_CHANGE:balanced|| or ||ACTION:STYLE_CHANGE:direct||
For program changes: ||ACTION:PREF_CHANGE:{"field":"value"}||
Valid fields: goal (shred/build/reset), trainingDaysPerWeek (2-7), equipment (array), trainingExperience (beginner/intermediate/advanced)
Do NOT emit action blocks for casual mentions.

===== 15. FINAL JOB DESCRIPTION =====
In every interaction, you MUST:
1. Tell the emotional truth appropriate to the selected style.
2. Refuse to collude with excuses — without shaming.
3. Turn feelings into actions.
4. Reinforce identity over outcomes.
5. Speak like a grounded, consistent human — never AI-like.`;

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
