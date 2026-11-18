// The standard course library (HRMS phase 10): the dashboard's ten sample courses (lib/hrms/people/seedLearning.ts),
// with their lessons and quizzes, for a company to start from. GENERATED from the dashboard's COURSES so the two never
// drift: regenerate when the sample courses change.
//
// Differences from the sample, because a real company has its own departments, designations and locations:
//  - every course is for "Everyone" (the sample's audiences name sample departments / locations that do not exist here);
//  - only the courses that were already for everyone stay mandatory (POSH, data protection, code of conduct). The
//    role-specific ones (safety, field selling, people management, ...) arrive as recommended, so "Apply rules" does not
//    assign warehouse safety to the whole company: an admin picks who each is for, then makes it mandatory;
//  - the owner is the team, not a sample person.

export interface LibraryLesson { title: string; body: string }
export interface LibraryQuestion { q: string; options: string[]; answer: number }
export interface LibraryCourse {
  code: string;
  title: string;
  category: 'compliance' | 'skill';
  mode: 'self_paced' | 'classroom';
  durationMin: number;
  summary: string;
  mandatory: boolean;
  refresherMonths: number;
  dueDays: number;
  owner: string;
  lessons: LibraryLesson[];
  quiz: LibraryQuestion[];
}

export const STANDARD_COURSES: LibraryCourse[] = [
  {
    "code": "POSH",
    "title": "POSH awareness",
    "category": "compliance",
    "mode": "self_paced",
    "durationMin": 45,
    "summary": "What sexual harassment at work looks like, how to raise a concern and what the Internal Committee does.",
    "mandatory": true,
    "refresherMonths": 12,
    "dueDays": 30,
    "owner": "People team",
    "lessons": [
      {
        "title": "What counts as harassment at work",
        "body": "Unwelcome words, messages, touch or behaviour of a sexual nature can be harassment, whatever the intent. The impact on the person matters."
      },
      {
        "title": "How to raise a concern",
        "body": "You can go to the Internal Committee or the People team. You can ask for support at any step, and your concern is handled in confidence."
      },
      {
        "title": "What the Internal Committee does",
        "body": "The committee listens to both sides, looks at the evidence and recommends action. Raising a concern in good faith is never held against you."
      }
    ],
    "quiz": [
      {
        "q": "Under our policy, where can you raise a concern?",
        "options": [
          "The Internal Committee, or the People team",
          "Only on social media",
          "Nowhere, it waits for the yearly review"
        ],
        "answer": 0
      },
      {
        "q": "Is it allowed to punish someone for raising a concern in good faith?",
        "options": [
          "Yes, if the concern is minor",
          "No, never",
          "Only if a manager agrees"
        ],
        "answer": 1
      },
      {
        "q": "Behaviour can be a concern even if it was not meant to upset anyone.",
        "options": [
          "True",
          "False"
        ],
        "answer": 0
      }
    ]
  },
  {
    "code": "DATA",
    "title": "Data protection basics",
    "category": "compliance",
    "mode": "self_paced",
    "durationMin": 30,
    "summary": "Handling personal data of employees, customers and candidates, and what to do if something goes wrong.",
    "mandatory": true,
    "refresherMonths": 12,
    "dueDays": 30,
    "owner": "Technology team",
    "lessons": [
      {
        "title": "Personal data in our work",
        "body": "Names, phone numbers, bank and ID details are personal data. We keep only what a task needs and only for as long as it is needed."
      },
      {
        "title": "Collect less, share less",
        "body": "Never keep a full Aadhaar number. Keep the last four digits. Share files with the people who need them, not with whole groups."
      },
      {
        "title": "Reporting a data incident",
        "body": "If data goes to the wrong person or a device is lost, tell the People team or IT the same day. Reporting early limits the harm."
      }
    ],
    "quiz": [
      {
        "q": "Which Aadhaar detail may we keep on an employee record?",
        "options": [
          "The full number",
          "The last four digits only",
          "A photo of the card on a shared drive"
        ],
        "answer": 1
      },
      {
        "q": "You sent a payslip to the wrong colleague. What do you do first?",
        "options": [
          "Say nothing",
          "Report it to the People team the same day",
          "Delete the mail and hope"
        ],
        "answer": 1
      },
      {
        "q": "Tracking a person's location outside duty hours is fine.",
        "options": [
          "True",
          "False"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "CODE",
    "title": "Code of conduct",
    "category": "compliance",
    "mode": "self_paced",
    "durationMin": 25,
    "summary": "Our values at work, gifts and conflicts of interest, and how to speak up.",
    "mandatory": true,
    "refresherMonths": 12,
    "dueDays": 30,
    "owner": "People team",
    "lessons": [
      {
        "title": "Our values at work",
        "body": "We deal honestly with customers, suppliers and each other. We treat people with respect, whatever their role."
      },
      {
        "title": "Gifts and conflicts of interest",
        "body": "Decline gifts that could influence a decision, or declare them to your manager. Tell us early if a personal interest overlaps with your work."
      },
      {
        "title": "Speaking up",
        "body": "Raise a concern with your manager or the People team. We do not allow retaliation against anyone who speaks up in good faith."
      }
    ],
    "quiz": [
      {
        "q": "A supplier offers you an expensive gift. What do you do?",
        "options": [
          "Accept it quietly",
          "Decline it, or declare it to your manager",
          "Keep it and return the favour"
        ],
        "answer": 1
      },
      {
        "q": "Where can you raise a concern about a breach of the code?",
        "options": [
          "Your manager or the People team",
          "Nowhere",
          "Only outside the company"
        ],
        "answer": 0
      },
      {
        "q": "Using company data for a side business is fine after hours.",
        "options": [
          "True",
          "False"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "SAFE-O",
    "title": "Workplace safety (office)",
    "category": "compliance",
    "mode": "classroom",
    "durationMin": 60,
    "summary": "Fire exits, first aid and reporting an incident or near miss in the Delhi and Bengaluru offices.",
    "mandatory": false,
    "refresherMonths": 12,
    "dueDays": 45,
    "owner": "Operations team",
    "lessons": [
      {
        "title": "Fire exits and assembly points",
        "body": "Know your two nearest exits and the assembly point. Never use the lift in a fire alarm."
      },
      {
        "title": "First aid basics",
        "body": "Find the first aid box on your floor. For anything serious, call the emergency number first, then the floor safety contact."
      },
      {
        "title": "Reporting an incident or near miss",
        "body": "Tell the floor safety contact about injuries and near misses. A near miss is a free lesson."
      }
    ],
    "quiz": [
      {
        "q": "A fire alarm sounds. What do you do?",
        "options": [
          "Finish your work first",
          "Leave by the nearest exit and go to the assembly point",
          "Take the lift"
        ],
        "answer": 1
      },
      {
        "q": "A near miss, where nobody was hurt, should still be reported.",
        "options": [
          "True",
          "False"
        ],
        "answer": 0
      },
      {
        "q": "You see a blocked fire exit. Who do you tell?",
        "options": [
          "Nobody",
          "The floor safety contact or Operations",
          "Wait for the audit"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "SAFE-W",
    "title": "Warehouse safety",
    "category": "compliance",
    "mode": "classroom",
    "durationMin": 90,
    "summary": "Walkways, racking, loading bays, protective gear and emergency drills at the Bhiwandi warehouse.",
    "mandatory": false,
    "refresherMonths": 6,
    "dueDays": 30,
    "owner": "Operations team",
    "lessons": [
      {
        "title": "Walkways, racking and loading bays",
        "body": "Keep walkways clear. Stack only to the marked rack height. Chock the wheels of any truck at the loading bay."
      },
      {
        "title": "Protective equipment",
        "body": "Safety shoes and a high-visibility vest are needed on the floor. Gloves and helmets apply to the tasks listed at the gate."
      },
      {
        "title": "Emergency drills and reporting",
        "body": "Know the assembly point and the night-shift contact. Report every injury and near miss before the end of your shift."
      }
    ],
    "quiz": [
      {
        "q": "Which protective gear is required on the warehouse floor?",
        "options": [
          "Safety shoes and a high-visibility vest",
          "Open sandals",
          "None for a short visit"
        ],
        "answer": 0
      },
      {
        "q": "A forklift is reversing near you. You should",
        "options": [
          "Cross behind it quickly",
          "Stay clear and make eye contact with the driver",
          "Wave and walk past"
        ],
        "answer": 1
      },
      {
        "q": "You may block an emergency exit with stock for an hour.",
        "options": [
          "True",
          "False"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "HANDLE",
    "title": "Manual handling and forklift awareness",
    "category": "compliance",
    "mode": "classroom",
    "durationMin": 60,
    "summary": "Lifting without injury and working safely around forklifts and loads.",
    "mandatory": false,
    "refresherMonths": 12,
    "dueDays": 45,
    "owner": "Warehouse team",
    "lessons": [
      {
        "title": "Lifting without injury",
        "body": "Bend your knees, keep the load close and do not twist. Use a trolley or ask for help when a load is awkward."
      },
      {
        "title": "Working around forklifts",
        "body": "Only trained and authorised people drive a forklift. Pedestrians keep to marked paths."
      },
      {
        "title": "Load limits",
        "body": "Check the load limit on the rack and the vehicle. Overloading is a reason to stop and ask."
      }
    ],
    "quiz": [
      {
        "q": "Safe lifting starts with",
        "options": [
          "Bending the back",
          "Bending the knees and keeping the load close",
          "Twisting as you lift"
        ],
        "answer": 1
      },
      {
        "q": "Only trained and authorised people may drive a forklift.",
        "options": [
          "True",
          "False"
        ],
        "answer": 0
      },
      {
        "q": "A load looks too heavy. You",
        "options": [
          "Try anyway",
          "Ask for help or a lifting aid",
          "Drag it"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "FIELD",
    "title": "Field selling essentials",
    "category": "skill",
    "mode": "classroom",
    "durationMin": 180,
    "summary": "Planning a beat, opening a visit, asking good questions and recording the visit.",
    "mandatory": false,
    "refresherMonths": 0,
    "dueDays": 60,
    "owner": "Sales team",
    "lessons": [
      {
        "title": "Planning a beat",
        "body": "Look at last visit notes and open orders before you leave. Group visits by area to save travel time."
      },
      {
        "title": "Opening a visit and asking questions",
        "body": "Start with the retailer's stock and what sells fastest. Listen first, then offer."
      },
      {
        "title": "Closing and recording",
        "body": "Agree the next step before you leave. Record every visit in the app with a photo."
      }
    ],
    "quiz": [
      {
        "q": "Before a visit you should",
        "options": [
          "Check the last visit notes and any open order",
          "Walk in cold",
          "Skip planning"
        ],
        "answer": 0
      },
      {
        "q": "A good first question to a retailer is about",
        "options": [
          "Your sales target",
          "Their current stock and what sells fastest",
          "Your commission"
        ],
        "answer": 1
      },
      {
        "q": "After the visit, record it in the app",
        "options": [
          "Only if you made a sale",
          "Every time, with a photo",
          "At month end"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "EXCEL",
    "title": "Excel for finance",
    "category": "skill",
    "mode": "self_paced",
    "durationMin": 120,
    "summary": "Clean tables, lookups, pivot tables and the checks that catch errors before a report goes out.",
    "mandatory": false,
    "refresherMonths": 0,
    "dueDays": 60,
    "owner": "Finance team",
    "lessons": [
      {
        "title": "Clean data and tables",
        "body": "One header row, one fact per column, no merged cells. A clean table makes every later step easier."
      },
      {
        "title": "Lookups and pivot tables",
        "body": "Use a lookup to bring a value from another table. Use a pivot table to total rows by category."
      },
      {
        "title": "Checks that catch errors",
        "body": "Tie your totals to the ledger. Trace and explain any difference before you share the file."
      }
    ],
    "quiz": [
      {
        "q": "Which function brings a value from another table?",
        "options": [
          "SUMIF",
          "XLOOKUP (or VLOOKUP)",
          "CONCAT"
        ],
        "answer": 1
      },
      {
        "q": "A pivot table is best for",
        "options": [
          "Summarising rows by category",
          "Drawing shapes",
          "Spell checking"
        ],
        "answer": 0
      },
      {
        "q": "A total that does not match the ledger should be",
        "options": [
          "Hidden",
          "Traced and explained before sharing",
          "Rounded to match"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "PEOPLE",
    "title": "People management",
    "category": "skill",
    "mode": "classroom",
    "durationMin": 240,
    "summary": "One-to-ones that help, giving feedback, and making fair decisions you can explain.",
    "mandatory": false,
    "refresherMonths": 0,
    "dueDays": 90,
    "owner": "People team",
    "lessons": [
      {
        "title": "One-to-ones that help",
        "body": "Use the time for the person's work, growth and blockers. Keep the slot even when you are busy."
      },
      {
        "title": "Giving feedback",
        "body": "Be specific, be timely, and give it in private. Describe what you saw and what it caused."
      },
      {
        "title": "Fair decisions and records",
        "body": "Before a decision that affects pay or a job, share the evidence and let the person reply. Keep notes you could show them."
      }
    ],
    "quiz": [
      {
        "q": "A good one-to-one is mainly",
        "options": [
          "A status report to you",
          "A conversation about the person's work, growth and blockers",
          "Skipped when busy"
        ],
        "answer": 1
      },
      {
        "q": "Feedback works best when it is",
        "options": [
          "Specific and timely",
          "Vague and saved for the review",
          "Given in front of the team"
        ],
        "answer": 0
      },
      {
        "q": "Before a decision that affects pay or a job, the person should",
        "options": [
          "Hear about it afterwards",
          "See the evidence and get a chance to reply",
          "Not be told"
        ],
        "answer": 1
      }
    ]
  },
  {
    "code": "SECURE",
    "title": "Secure coding basics",
    "category": "skill",
    "mode": "self_paced",
    "durationMin": 90,
    "summary": "Validating input, keeping secrets out of code and reviewing changes for risk.",
    "mandatory": false,
    "refresherMonths": 0,
    "dueDays": 60,
    "owner": "Technology team",
    "lessons": [
      {
        "title": "Never trust input",
        "body": "Validate and escape anything that comes from a user or another system before you use it."
      },
      {
        "title": "Secrets and keys",
        "body": "Keys and passwords live in a secrets store, never in the repository or a chat message."
      },
      {
        "title": "Reviewing code for risk",
        "body": "Changes that touch payments, personal data or access need a second reviewer."
      }
    ],
    "quiz": [
      {
        "q": "Where do API keys belong?",
        "options": [
          "In the code repository",
          "In a secrets store, not in code",
          "In a chat message"
        ],
        "answer": 1
      },
      {
        "q": "User input should be",
        "options": [
          "Trusted",
          "Validated and escaped",
          "Ignored"
        ],
        "answer": 1
      },
      {
        "q": "A pull request that touches payments needs",
        "options": [
          "No review",
          "A second reviewer",
          "Only a quick glance"
        ],
        "answer": 1
      }
    ]
  }
];
