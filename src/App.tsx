import React, { useEffect, useMemo, useRef, useState } from 'react';
import { initializeApp, getApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithCustomToken,
  signInAnonymously,
  onAuthStateChanged,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
  setPersistence,
  type Auth,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  query,
  addDoc,
  serverTimestamp,
  doc,
  setDoc,
  orderBy,
  limit,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import { Zap, Send, Edit, Award, X, Check } from 'lucide-react';

// =============================================================
// Types
// =============================================================

type QuizQuestion = {
  question: string;
  options: string[];
  answer: string;
};

type QuizData = Record<string, QuizQuestion[]>;

type QuestionDoc = {
  id: string;
  title: string;
  body: string;
  authorId: string;
  category: string;
  status: 'Open' | 'Closed';
  createdAt?: Timestamp; // Firestore server timestamp
  createdAtMs?: number;  // client fallback
};

type VerificationDoc = {
  id: string; // uid
  displayName?: string | null;
  verifiedCategories: string[];
  lastUpdated?: Timestamp;
};

// =============================================================
// Env (Vite-style). Ensure .env contains VITE_* keys and restart dev server.
// =============================================================

const firebaseConfig = {
  apiKey: import.meta.env.VITE_apiKey ?? '',
  authDomain: import.meta.env.VITE_authDomain ?? '',
  projectId: import.meta.env.VITE_projectId ?? '',
  storageBucket: import.meta.env.VITE_storageBucket ?? '',
  messagingSenderId: import.meta.env.VITE_messagingSenderId ?? '',
  appId: import.meta.env.VITE_appId ?? '',
};

const APP_ID = import.meta.env.VITE_APP_ID || 'default-app-id';
const INITIAL_AUTH_TOKEN: string | null = import.meta.env.VITE_INITIAL_AUTH_TOKEN || null;

const getPublicCollectionPath = (collectionName: string) =>
  `artifacts/${APP_ID}/public/data/${collectionName}`;

// =============================================================
// Quiz Data
// =============================================================

const QUIZ_DATA: QuizData = {
  Physics: [
    {
      question:
        "What principle states that the total momentum of a closed system remains constant?",
      options: [
        "Huygens' Principle",
        'Principle of Conservation of Momentum',
        "Archimedes' Principle",
        "Bernoulli's Principle",
      ],
      answer: 'Principle of Conservation of Momentum',
    },
    {
      question: 'What is the SI unit of electric current?',
      options: ['Volt', 'Ohm', 'Ampere', 'Watt'],
      answer: 'Ampere',
    },
    {
      question:
        'Which phenomenon is responsible for the apparent bending of a spoon in a glass of water?',
      options: ['Diffraction', 'Refraction', 'Polarization', 'Interference'],
      answer: 'Refraction',
    },
  ],
  'Web Development': [
    {
      question:
        'Which CSS property is used to create space around elements, outside of any defined borders?',
      options: ['padding', 'margin', 'border-width', 'inset'],
      answer: 'margin',
    },
    {
      question:
        'In React, what is used to handle data that changes over time within a component?',
      options: ['props', 'state', 'context', 'refs'],
      answer: 'state',
    },
  ],
  'Financial Modeling': [
    {
      question: 'What does NPV stand for in financial modeling?',
      options: [
        'Net Profit Variance',
        'Nominal Price Value',
        'Net Present Value',
        'New Project Valuation',
      ],
      answer: 'Net Present Value',
    },
  ],
};

const PASSING_SCORE_PERCENTAGE = 0.7;

// =============================================================
// Small UI bits
// =============================================================

const ExpertBadge: React.FC<{ categories: string[] }> = ({ categories = [] }) => {
  if (!categories.length) return null;
  return (
    <div className="flex items-center space-x-2 text-sm text-green-600 bg-green-50 p-1 px-3 rounded-full shadow-sm">
      <Award size={16} className="text-green-500" />
      <span className="font-semibold">Expert in:</span>
      <span className="font-medium">{categories.join(', ')}</span>
    </div>
  );
};

// =============================================================
// Main App
// =============================================================

const App: React.FC = () => {
  // Core state
  const [db, setDb] = useState<Firestore | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [appState, setAppState] = useState<'feed' | 'post' | 'quiz'>('feed');

  // Quiz state
  const [activeQuizCategory, setActiveQuizCategory] = useState<string | null>(null);

  // Data
  const [questions, setQuestions] = useState<QuestionDoc[]>([]);
  const [userVerifications, setUserVerifications] = useState<VerificationDoc[]>([]);

  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------
  // Firebase init + Auth (robust, clear errors)
  // -------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        // Validate env before touching Firebase
        const missing = Object.entries({
          apiKey: firebaseConfig.apiKey,
          projectId: firebaseConfig.projectId,
          appId: firebaseConfig.appId,
        })
          .filter(([, v]) => !v)
          .map(([k]) => k);
        if (missing.length) {
          setError(
            `Firebase config missing: ${missing.join(', ')}. Check your .env and restart the dev server.`,
          );
          setIsLoading(false);
          return;
        }

        // Single app instance (prevents duplicate init on HMR)
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

        // Auth with graceful persistence fallback
        let authInstance: Auth;
        try {
          authInstance = initializeAuth(app, {
            persistence: [
              indexedDBLocalPersistence,
              browserLocalPersistence,
              inMemoryPersistence,
            ],
          });
        } catch {
          authInstance = getAuth(app);
        }
        try {
          await setPersistence(authInstance, indexedDBLocalPersistence);
        } catch {
          try {
            await setPersistence(authInstance, browserLocalPersistence);
          } catch {
            await setPersistence(authInstance, inMemoryPersistence);
          }
        }

        // Firestore init
        const firestore = getFirestore(app);
        setDb(firestore);

        // Sign in (custom token if provided, else anonymous)
        try {
          if (INITIAL_AUTH_TOKEN) {
            await signInWithCustomToken(authInstance, INITIAL_AUTH_TOKEN);
          } else {
            await signInAnonymously(authInstance);
          }
        } catch (authErr: any) {
          console.error('[Auth] sign-in error', authErr);
          const code = authErr?.code || '';
          let msg = `Auth error: ${code}`;
          if (code === 'auth/operation-not-allowed') {
            msg =
              'Auth error: Anonymous sign-in is disabled. Enable it in Firebase Console → Authentication → Sign-in Method.';
          } else if (code === 'auth/unauthorized-domain') {
            msg =
              'Auth error: Unauthorized domain. Add your dev URL in Firebase Console → Authentication → Settings → Authorized domains.';
          } else if (code === 'auth/operation-not-supported-in-this-environment') {
            msg =
              'Auth error: Storage blocked in this environment. Try another browser or disable private mode.';
          } else if (code === 'auth/invalid-custom-token') {
            msg =
              'Auth error: Invalid custom token. Remove VITE_INITIAL_AUTH_TOKEN to test anonymous, or issue a token for this project.';
          }
          setError(msg);
          setIsLoading(false);
          return;
        }

        // Observe auth state
        const unsub = onAuthStateChanged(authInstance, (user) => {
          if (user) {
            setUserId(user.uid);
            setDisplayName(user.displayName || `User-${user.uid.substring(0, 8)}`);
          } else {
            setUserId(null);
            setDisplayName(null);
          }
          setIsLoading(false);
        });

        return () => unsub();
      } catch (e: any) {
        console.error('[Firebase init] fatal', e);
        setError(`Firebase init error: ${e?.code || e?.message || String(e)}`);
        setIsLoading(false);
      }
    })();
  }, []);

  // -------------------------------------------------------------
  // Realtime listeners (Questions + Verification doc)
  // -------------------------------------------------------------
  useEffect(() => {
    if (!db || !userId) return;

    // Questions feed ordered server-side
    const q = query(
      collection(db, getPublicCollectionPath('questions')),
      orderBy('createdAt', 'desc'),
      limit(50),
    );
    const unsubQuestions = onSnapshot(
      q,
      (snapshot) => {
        const list: QuestionDoc[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<QuestionDoc, 'id'>),
        }));
        setQuestions(list);
      },
      (err) => {
        console.error('Error fetching questions:', err);
        setError('Failed to load questions from database.');
      },
    );

    // User verification (single doc)
    const vdoc = doc(db, getPublicCollectionPath('expert_verifications'), userId);
    const unsubVer = onSnapshot(
      vdoc,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Omit<VerificationDoc, 'id'>;
          setUserVerifications([{ id: snap.id, ...data }]);
        } else {
          setUserVerifications([{ id: userId, verifiedCategories: [] }]);
        }
      },
      (err) => {
        console.error('Error fetching verifications:', err);
      },
    );

    return () => {
      unsubQuestions();
      unsubVer();
    };
  }, [db, userId]);

  // Derived: current user's verifications
  const currentUserVerifications = useMemo<VerificationDoc>(() => {
    const v = userVerifications.find((v) => v.id === userId);
    return v || { id: userId || 'unknown', verifiedCategories: [] };
  }, [userId, userVerifications]);

  // -------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------
  const handlePostQuestion = async (title: string, body: string, category: string) => {
    if (!db || !userId) return;
    try {
      await addDoc(collection(db, getPublicCollectionPath('questions')), {
        title,
        body,
        authorId: userId,
        category,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        status: 'Open',
      });
      setAppState('feed');
    } catch (e) {
      console.error('Error posting question:', e);
      setError('Could not post question. Check network connection or database permissions.');
    }
  };

  const handleQuizComplete = async (category: string, score: number, total: number) => {
    if (!db || !userId) return;

    const scorePercentage = score / total;
    const passed = scorePercentage >= PASSING_SCORE_PERCENTAGE;
    const userDocRef = doc(db, getPublicCollectionPath('expert_verifications'), userId);

    if (passed) {
      try {
        const newCategories = Array.from(
          new Set([...(currentUserVerifications.verifiedCategories || []), category]),
        );

        await setDoc(
          userDocRef,
          {
            displayName,
            verifiedCategories: newCategories,
            lastUpdated: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (e) {
        console.error('Error updating verification status:', e);
        setError(`Failed to verify expertise in ${category}.`);
      }
    }

    setActiveQuizCategory(null);
  };

  // -------------------------------------------------------------
  // Components
  // -------------------------------------------------------------
  const Header: React.FC = () => (
    <header className="bg-white shadow-md p-4 flex justify-between items-center sticky top-0 z-10">
      <h1 className="text-3xl font-extrabold text-indigo-700 tracking-tight">
        <span className="text-indigo-500">Cross</span>point
      </h1>
      <div className="flex items-center space-x-4">
        <ExpertBadge categories={currentUserVerifications.verifiedCategories || []} />
        <div className="text-sm font-medium text-gray-600">
          ID:{' '}
          <span className="font-mono text-xs p-1 bg-gray-100 rounded">
            {userId || 'Loading...'}
          </span>
        </div>
        <button
          onClick={() => {
            setAppState('quiz');
            setActiveQuizCategory(null);
          }}
          className="bg-purple-500 hover:bg-purple-600 text-white font-semibold py-2 px-4 rounded-lg transition duration-200 shadow-lg flex items-center"
        >
          <Award size={18} className="mr-2" />
          Take Quiz
        </button>
      </div>
    </header>
  );

  const ActiveQuiz: React.FC<{
    category: string;
    onComplete: (
      category: string | null,
      finalScore: number | null,
      total: number | null,
    ) => void;
    quizData: QuizQuestion[];
  }> = ({ category, onComplete, quizData }) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [score, setScore] = useState(0);
    const [selectedOption, setSelectedOption] = useState<string | null>(null);
    const [showResult, setShowResult] = useState(false);
    const [pendingAdvance, setPendingAdvance] = useState(false);
    const timerRef = useRef<number | null>(null);

    useEffect(() => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    }, []);

    const currentQuestion = quizData[currentQuestionIndex];
    const totalQuestions = quizData.length;
    const isLastQuestion = currentQuestionIndex === totalQuestions - 1;

    const handleAnswerSelect = (option: string) => {
      if (showResult) return;
      setSelectedOption(option);
    };

    const handleNext = () => {
      if (!selectedOption || showResult || pendingAdvance) return;
      const isCorrect = selectedOption === currentQuestion.answer;
      setShowResult(true);
      setPendingAdvance(true);

      const finalScore = score + (isCorrect ? 1 : 0);

      timerRef.current = window.setTimeout(() => {
        if (isLastQuestion) {
          onComplete(category, finalScore, totalQuestions);
        } else {
          setCurrentQuestionIndex((i) => i + 1);
          setSelectedOption(null);
          setShowResult(false);
          setScore(finalScore);
          setPendingAdvance(false);
        }
      }, 800);
    };

    return (
      <div className="p-8 bg-white rounded-xl shadow-2xl border border-purple-200">
        <h2 className="text-3xl font-bold text-gray-800 mb-2">{category} Expert Quiz</h2>
        <p className="text-sm text-gray-500 mb-6">
          Question {currentQuestionIndex + 1} of {totalQuestions}
        </p>

        <div className="bg-indigo-50 p-6 rounded-lg mb-6">
          <p className="text-xl font-semibold text-gray-800">
            {currentQuestion.question}
          </p>
        </div>

        <div className="space-y-3 mb-6">
          {currentQuestion.options.map((option, index) => {
            const isSelected = selectedOption === option;
            const isCorrect = showResult && option === currentQuestion.answer;
            const isIncorrectSelection = showResult && isSelected && !isCorrect;

            let className =
              'p-4 border rounded-lg cursor-pointer transition duration-150 flex items-center justify-between';

            if (showResult) {
              if (isCorrect) {
                className += ' bg-green-100 border-green-500 text-green-700 font-bold';
              } else if (isIncorrectSelection) {
                className += ' bg-red-100 border-red-500 text-red-700 font-bold';
              } else {
                className += ' bg-gray-50 border-gray-200 text-gray-600 opacity-50';
              }
            } else {
              className += isSelected
                ? ' bg-indigo-100 border-indigo-500 text-indigo-700 font-semibold shadow-md'
                : ' bg-white border-gray-200 hover:bg-gray-50';
            }

            return (
              <div key={index} className={className} onClick={() => handleAnswerSelect(option)}>
                {option}
                {showResult && (isCorrect ? (
                  <Check size={20} />
                ) : isIncorrectSelection ? (
                  <X size={20} />
                ) : null)}
              </div>
            );
          })}
        </div>

        <button
          onClick={handleNext}
          disabled={!selectedOption || showResult}
          className={`w-full font-bold py-3 px-4 rounded-lg transition duration-200 shadow-md flex items-center justify-center ${
            selectedOption && !showResult
              ? 'bg-purple-600 hover:bg-purple-700 text-white'
              : 'bg-gray-300 text-gray-600 cursor-not-allowed'
          }`}
        >
          {isLastQuestion ? 'Submit Quiz' : 'Next Question'}
        </button>
        <button
          onClick={() => onComplete(null, null, null)}
          className="mt-4 text-sm text-gray-500 hover:text-red-500 transition duration-150 w-full"
        >
          Cancel Quiz
        </button>
      </div>
    );
  };

  const QuizCategorySelectionView: React.FC = () => {
    if (activeQuizCategory) {
      const quizData = QUIZ_DATA[activeQuizCategory];
      if (!quizData) {
        return (
          <div className="p-8 text-center text-red-500">
            Quiz data not found for {activeQuizCategory}.
          </div>
        );
      }
      return (
        <ActiveQuiz
          category={activeQuizCategory}
          onComplete={(category, finalScore, total) => {
            setAppState('feed');
            if (category && finalScore != null && total != null) {
              void handleQuizComplete(category, finalScore, total);
            }
          }}
          quizData={quizData}
        />
      );
    }

    const availableCategories = Object.keys(QUIZ_DATA);

    return (
      <div className="p-8 max-w-2xl mx-auto bg-white rounded-xl shadow-2xl border border-purple-200">
        <h2 className="text-3xl font-bold text-gray-800 mb-4 flex items-center">
          <Zap size={24} className="mr-2 text-purple-600" />
          Expert Verification Quiz
        </h2>
        <p className="text-gray-600 mb-6">
          To become a verified expert, select a category and pass the quiz with a
          score of <span className="font-semibold">{PASSING_SCORE_PERCENTAGE * 100}%</span> or higher.
        </p>
        <div className="space-y-4">
          {availableCategories.map((category) => (
            <div
              key={category}
              className="p-4 bg-gray-50 rounded-lg border border-gray-200 flex justify-between items-center"
            >
              <span className="font-semibold text-lg text-gray-700">{category}</span>
              {currentUserVerifications.verifiedCategories?.includes(category) ? (
                <span className="text-green-600 font-bold flex items-center">
                  <Award size={18} className="mr-1" /> VERIFIED
                </span>
              ) : (
                <button
                  className="bg-indigo-500 hover:bg-indigo-600 text-white py-1 px-3 rounded-md text-sm transition duration-150"
                  onClick={() => setActiveQuizCategory(category)}
                >
                  Start Quiz
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => setAppState('feed')}
          className="mt-8 text-indigo-600 hover:text-indigo-800 transition duration-150 font-medium"
        >
          &larr; Back to Question Feed
        </button>
      </div>
    );
  };

  const PostQuestionView: React.FC = () => {
    const [title, setTitle] = useState<string>('');
    const [body, setBody] = useState<string>('');
    const [category, setCategory] = useState<string>(Object.keys(QUIZ_DATA)[0] || 'General');

    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (title.trim() && body.trim() && category) {
        void handlePostQuestion(title, body, category);
      }
    };

    return (
      <div className="p-8 max-w-xl mx-auto bg-white rounded-xl shadow-2xl border border-indigo-200">
        <h2 className="text-3xl font-bold text-gray-800 mb-6 flex items-center">
          <Edit size={24} className="mr-2 text-indigo-600" />
          Post a New Question
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">
              Question Title (Summary)
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
              placeholder="What is the difference between a mutex and a semaphore?"
              className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
              required
            />
          </div>
          <div>
            <label htmlFor="body" className="block text-sm font-medium text-gray-700">
              Detailed Question
            </label>
            <textarea
              id="body"
              value={body}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value)}
              rows={4}
              placeholder="Provide all necessary details and context for the experts..."
              className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
              required
            />
          </div>
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-gray-700">
              Category
            </label>
            <select
              id="category"
              value={category}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCategory(e.target.value)}
              className="mt-1 block w-full border border-gray-300 rounded-lg shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
              required
            >
              {Object.keys(QUIZ_DATA).map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
              <option value="General">General</option>
            </select>
          </div>
          <button
            type="submit"
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-4 rounded-lg transition duration-200 shadow-md flex items-center justify-center"
          >
            <Send size={18} className="mr-2" />
            Submit Question
          </button>
        </form>
        <button
          onClick={() => setAppState('feed')}
          className="mt-6 text-gray-600 hover:text-gray-800 transition duration-150 font-medium w-full text-center"
        >
          &larr; Cancel
        </button>
      </div>
    );
  };

  const QuestionCard: React.FC<{ question: QuestionDoc }> = ({ question }) => {
    const isExpert = currentUserVerifications.verifiedCategories?.includes(question.category);

    return (
      <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 transition duration-300 hover:shadow-xl">
        <div className="flex justify-between items-start mb-3">
          <span className="text-xs font-semibold uppercase text-indigo-600 bg-indigo-100 px-3 py-1 rounded-full">
            {question.category}
          </span>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              question.status === 'Open' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'
            }`}
          >
            {question.status}
          </span>
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">{question.title}</h3>
        <p className="text-gray-600 mb-4 line-clamp-2">{question.body}</p>

        <div className="flex justify-between items-center pt-2 border-t border-gray-100">
          <span className="text-sm text-gray-500">
            Asked by:{' '}
            <span className="font-semibold text-gray-700">{question.authorId?.substring(0, 8)}...</span>
          </span>
          {isExpert ? (
            <button
              onClick={() => alert(`Simulating posting a verified answer to: ${question.title}`)}
              className="bg-green-500 hover:bg-green-600 text-white text-sm font-semibold py-1.5 px-3 rounded-lg flex items-center transition duration-150"
            >
              <Send size={16} className="mr-1" /> Answer
            </button>
          ) : (
            <span className="text-sm text-yellow-600 font-medium">Get Verified to Answer</span>
          )}
        </div>
      </div>
    );
  };

  const QuestionFeedView: React.FC = () => (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6 max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-gray-800">Latest Questions</h2>
        <button
          onClick={() => setAppState('post')}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-6 rounded-lg transition duration-200 shadow-xl flex items-center"
        >
          <Edit size={18} className="mr-2" />
          Ask a Question
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
        {questions.length === 0 ? (
          <div className="md:col-span-3 text-center p-12 bg-gray-50 rounded-xl">
            <p className="text-xl text-gray-500">No questions posted yet. Be the first!</p>
          </div>
        ) : (
          questions.map((q) => <QuestionCard key={q.id} question={q} />)
        )}
      </div>
    </div>
  );

  // -------------------------------------------------------------
  // Render
  // -------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-lg font-medium text-indigo-600 animate-pulse">Loading Crosspoint...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-red-50 p-8">
        <div className="bg-white p-6 rounded-xl shadow-lg border-l-4 border-red-500 max-w-xl">
          <h2 className="text-xl font-bold text-red-700 mb-2">Application Error</h2>
          <p className="text-gray-700">{error}</p>
          <p className="text-sm text-gray-500 mt-4">Open the browser console for details and error codes.</p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    switch (appState) {
      case 'post':
        return <PostQuestionView />;
      case 'quiz':
        return <QuizCategorySelectionView />;
      case 'feed':
      default:
        return <QuestionFeedView />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');
        body { font-family: 'Inter', sans-serif; }
      `}</style>
      <Header />
      <main className="py-8">{renderContent()}</main>
      <footer className="p-4 text-center text-sm text-gray-500 border-t mt-12">
        Crosspoint - Built with React and Firebase (App ID: {APP_ID})
      </footer>
    </div>
  );
};

export default App;
