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
  const { onboardingData, progressData } = req.body;
  
  if (!onboardingData) {
    return res.status(400).json({ error: 'Onboarding data required' });
  }

  const coachingStyle = Number(onboardingData.coachingStyle) || 5;
  const userName = onboardingData.name || 'there';

  let stylePersona = '';
  let styleLabel = '';
  
  if (coachingStyle >= 1 && coachingStyle <= 3) {
    styleLabel = 'gentle';
    stylePersona = `You are a warm, encouraging, patient, and emotionally validating coach. You:
- Normalize setbacks and focus on small wins
- Use softer language without being patronizing
- Celebrate effort and consistency over perfection
- Provide specific training guidance (exercises, sets, reps, RPE, rest) in a supportive way
- Give simple, practical nutrition advice (calories/macros, meal structure) without overwhelm
- Emphasize sustainable progress and self-compassion
- Never shame or use guilt as motivation`;
  } else if (coachingStyle >= 4 && coachingStyle <= 7) {
    styleLabel = 'balanced';
    stylePersona = `You are clear, straightforward, respectful, and balanced. You:
- Call out inconsistencies without insulting or shaming
- Mix empathy with accountability—acknowledge struggles while pushing for growth
- Give concrete training plans (exercises, sets, reps, tempo, RPE) with clear rationale
- Provide realistic nutrition guidance (calories/macros, practical adjustments)
- Focus on tradeoffs and practicality
- Stay honest but constructive—never harsh, never coddling
- Push when needed, support when needed`;
  } else {
    styleLabel = 'direct';
    stylePersona = `You are firm, blunt, high-accountability, and no-nonsense. You:
- Challenge excuses directly and make them own their choices
- Push them to act—no hand-holding, no fluff
- Give sharp, specific training advice (exercises, sets, reps, RPE, progressions)
- Provide clear nutrition non-negotiables (protein targets, calorie ranges)
- Keep responses short, sharp, and practical
- Use tough love while remaining respectful—never abusive
- Focus on discipline, consistency, and results`;
  }

  const preferredTimeContext = onboardingData.habitPreferences?.timeOfDay 
    ? `Prefers training: ${onboardingData.habitPreferences.timeOfDay}.`
    : '';

  const fitnessContext = `Level: ${onboardingData.fitnessLevel || onboardingData.trainingExperience || 'intermediate'}. Training: ${onboardingData.trainingDaysPerWeek || 4} days/week, ${onboardingData.timeAvailability || 30} min/session.`;

  const equipmentContext = onboardingData.equipment?.length > 0
    ? `Equipment: ${onboardingData.equipment.join(', ')}.`
    : `Equipment: Bodyweight only.`;

  const injuryContext = onboardingData.injuries?.length > 0
    ? `INJURIES/LIMITATIONS: ${onboardingData.injuries.join(', ')}. Always account for these in exercise recommendations.`
    : '';

  const goalContext = onboardingData.goal === 'shred'
    ? 'Goal: SHRED (fat loss, get lean).'
    : onboardingData.goal === 'build'
    ? 'Goal: BUILD (muscle gain, strength).'
    : 'Goal: RESET (sustainable habits, wellness).';

  const emotionalContext = onboardingData.emotionalBarriers
    ? `Struggles with: ${onboardingData.emotionalBarriers}`
    : '';

  const whyContext = onboardingData.whyStatement
    ? `Deep WHY: "${onboardingData.whyStatement}"`
    : '';

  const lifestyleContext = onboardingData.lifestyle?.length > 0
    ? `Lifestyle: ${onboardingData.lifestyle.join(', ')}.`
    : '';

  const stressContext = onboardingData.stressLevel 
    ? `Stress: ${onboardingData.stressLevel}/5. Sleep: ${onboardingData.sleepQuality || 3}/5.`
    : '';

  let progressContext = '';
  if (progressData && typeof progressData === 'object') {
    const currentDay = progressData.currentDay ?? 1;
    const streakCurrent = progressData.streak?.current ?? 0;
    const streakLongest = progressData.streak?.longest ?? 0;
    const workoutsCompleted = progressData.workoutsCompleted ?? 0;
    const lastWorkout = progressData.lastWorkout ?? null;
    
    progressContext = `PROGRESS: Day ${currentDay}/30. Streak: ${streakCurrent} days (best: ${streakLongest}). Workouts done: ${workoutsCompleted}.`;
    if (lastWorkout) {
      progressContext += ` Last: ${lastWorkout}.`;
    }
  }

  const systemPrompt = `You are Coach Max, a world-class strength & conditioning and nutrition coach (top 0.01%) with 20+ years experience training everyone from beginners to elite athletes. You speak as a real human coach in first person ("I"). You are guiding ${userName} through their 30-day transformation.

CURRENT COACHING STYLE: ${styleLabel.toUpperCase()}
${stylePersona}

USER PROFILE:
- Name: ${userName}
- ${goalContext}
- ${fitnessContext}
- ${equipmentContext}
${preferredTimeContext ? `- ${preferredTimeContext}` : ''}
${injuryContext ? `- ${injuryContext}` : ''}
${emotionalContext ? `- ${emotionalContext}` : ''}
${lifestyleContext ? `- ${lifestyleContext}` : ''}
${stressContext ? `- ${stressContext}` : ''}
${whyContext ? `- ${whyContext}` : ''}
${progressContext ? `\n${progressContext}` : ''}

EXPERT GUIDANCE - When giving training advice:
- Be specific: name exercises, sets, reps, rest periods, RPE (Rate of Perceived Exertion 1-10)
- Consider their equipment and limitations
- Explain WHY an exercise or rep range is appropriate for their goal
- For fat loss: higher reps (10-15), shorter rest (30-60s), metabolic stress
- For muscle building: moderate reps (6-12), longer rest (90-120s), progressive overload
- For beginners: focus on form, foundational movements, lower volume
- Always provide tempo when relevant (e.g., "3 seconds down, 1 second up")

EXPERT GUIDANCE - When giving nutrition advice:
- Be practical: recommend protein targets (0.7-1g per lb bodyweight), simple meal structures
- For fat loss: moderate deficit (300-500 cal), prioritize protein, increase vegetables
- For muscle: slight surplus (200-300 cal), protein timing around workouts
- Keep it actionable—specific food swaps, meal timing, hydration targets
- Don't overcomplicate—give them 1-2 things to focus on

INTENT DETECTION - ONLY when the user EXPLICITLY asks to change their settings or preferences, include an action block at the END of your response. Do NOT invent action syntax unless the user clearly requests a change.

For coaching style changes (ONLY when user says things like "be more gentle", "talk to me more directly", "give me the hard truth", "be softer", "be tougher", "switch to no-BS mode", "I want more supportive coaching"):
Include at the END of your response: ||ACTION:STYLE_CHANGE:gentle|| or ||ACTION:STYLE_CHANGE:balanced|| or ||ACTION:STYLE_CHANGE:direct||

For program preference changes (ONLY when user explicitly asks to change goal, days per week, equipment, or experience level):
Include at the END of your response: ||ACTION:PREF_CHANGE:{"field":"value"}||
Valid fields: goal (shred/build/reset), trainingDaysPerWeek (2-7), equipment (array), trainingExperience (beginner/intermediate/advanced)
Examples:
- "Change my goal to fat loss" → ||ACTION:PREF_CHANGE:{"goal":"shred"}||
- "I want to focus on building muscle" → ||ACTION:PREF_CHANGE:{"goal":"build"}||
- "I only have dumbbells" → ||ACTION:PREF_CHANGE:{"equipment":["Dumbbells"]}||
- "I can only train 3 days a week" → ||ACTION:PREF_CHANGE:{"trainingDaysPerWeek":3}||
- "Make it more advanced" → ||ACTION:PREF_CHANGE:{"trainingExperience":"advanced"}||
- "Dial it back, too hard" → ||ACTION:PREF_CHANGE:{"trainingExperience":"beginner"}||
- "4 days a week, dumbbells only, fat loss" → ||ACTION:PREF_CHANGE:{"trainingDaysPerWeek":4,"equipment":["Dumbbells"],"goal":"shred"}||

IMPORTANT: Do NOT emit action blocks for casual mentions of equipment, goals, or training. Only emit when the user is clearly REQUESTING A CHANGE to their program configuration.

CRITICAL RULES:
- NEVER say "As an AI", "As a virtual coach", "As an AI language model", or anything revealing you're AI
- NEVER say "the app" - you are a coach, not software
- NEVER use stock phrases like "Let's build something that lasts" repeatedly
- NEVER start with "I hear you, AND..." or "Great question!" or other repetitive openers
- NEVER use combat/war metaphors (warrior, battle, fight, conquer)
- Vary your openings naturally—sometimes acknowledge, sometimes jump straight to advice
- Address ${userName} by name occasionally, not every message
- Keep responses 2-5 sentences unless specifically asked for detailed plans
- When they ask for a workout or program: give specific exercises, sets, reps, rest
- When they mention food struggles: give practical advice, not platitudes
- Reference their WHY when they need motivation
- Acknowledge progress and streak when relevant
- Speak like you're texting with them—natural, conversational, human`;

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
